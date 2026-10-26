import { describe, expect, it } from "vitest";
import type { EngineInstaller, EngineSetupProgress } from "@tomradex/agent";
import {
  applicableInstallers,
  bareLaunch,
  classifyFailure,
  installerLaunch,
  NPM_MIRROR,
  paced,
  runCommand,
  runInstall,
  runSignIn,
  stageOf,
  type SetupHost,
  type SetupRunResult
} from "../src/run.js";

const host = (over: Partial<SetupHost> = {}): SetupHost => ({
  platform: "darwin",
  env: { PATH: "/usr/bin" },
  answers: async () => false,
  npm: async () => bareLaunch("npm"),
  ...over
});

const NPM: EngineInstaller = { kind: "npm", package: "@x/cli" };
const SH: EngineInstaller = { kind: "script", url: "https://x.dev/install.sh", shell: "sh" };
const PS: EngineInstaller = { kind: "script", url: "https://x.dev/install.ps1", shell: "powershell" };
const BREW: EngineInstaller = { kind: "brew", name: "x", cask: true };

describe("which installers fit this machine", () => {
  it("keeps the declared order and drops the other platform's script and an absent brew", async () => {
    expect(await applicableInstallers([SH, PS, NPM, BREW], host())).toEqual([SH, NPM]);
    expect(await applicableInstallers([SH, PS, NPM, BREW], host({ platform: "win32" }))).toEqual([PS, NPM]);
    expect(await applicableInstallers([BREW, NPM], host({ answers: async (c) => c === "brew" }))).toEqual([BREW, NPM]);
    // brew only on macOS, even when something named brew answers
    expect(await applicableInstallers([BREW], host({ platform: "linux", answers: async () => true }))).toEqual([]);
  });

  it("offers an x64 archive on arm64 Windows and macOS only when there is no native one", async () => {
    const archive = (os: NodeJS.Platform, arch: string): EngineInstaller => ({ kind: "archive", url: `https://x.dev/${os}-${arch}.zip`, file: "x", platform: { os, arch } });
    const [winX64, winArm, macX64, linuxX64] = [archive("win32", "x64"), archive("win32", "arm64"), archive("darwin", "x64"), archive("linux", "x64")];
    expect(await applicableInstallers([winX64, NPM], host({ platform: "win32", arch: "arm64" }))).toEqual([winX64, NPM]);
    expect(await applicableInstallers([winX64, winArm], host({ platform: "win32", arch: "arm64" }))).toEqual([winArm]);
    expect(await applicableInstallers([macX64], host({ platform: "darwin", arch: "arm64" }))).toEqual([macX64]);
    expect(await applicableInstallers([linuxX64], host({ platform: "linux", arch: "arm64" }))).toEqual([]);
    expect(await applicableInstallers([winArm], host({ platform: "win32", arch: "x64" }))).toEqual([]);
  });
});

describe("how one installer runs", () => {
  it("runs npm install -g through the npm the machine answers with, and fails concretely without one", async () => {
    const launch = await installerLaunch(NPM, host());
    expect("launch" in launch && launch.args).toEqual(["install", "-g", "--loglevel", "http", "@x/cli"]);
    const missing = await installerLaunch(NPM, host({ npm: async () => null }));
    expect("failure" in missing && missing.failure.kind).toBe("not-found");
  });

  it("pipes the official script through bash or powershell", async () => {
    const sh = await installerLaunch(SH, host());
    expect("launch" in sh && [sh.launch.file, ...sh.args]).toEqual(["bash", "-c", "curl -fsSL https://x.dev/install.sh | bash"]);
    const ps = await installerLaunch(PS, host({ platform: "win32" }));
    expect("launch" in ps && [ps.launch.file, ps.args.at(-1)]).toEqual(["powershell.exe", "irm https://x.dev/install.ps1 | iex"]);
    const brew = await installerLaunch(BREW, host());
    expect("launch" in brew && [brew.launch.file, ...brew.args]).toEqual(["brew", "install", "--cask", "x"]);
  });
});

describe("what a failure is called", () => {
  const of = (output: string, code: number | null = 1, error?: SetupRunResult["error"]) => classifyFailure({ code, output, ...(error ? { error } : {}) }).kind;
  it("sorts the tool's words into kinds a screen can say", () => {
    expect(of("npm ERR! code ENOTFOUND registry.npmjs.org")).toBe("network");
    expect(of("npm ERR! 403 Forbidden")).toBe("registry");
    expect(of("EACCES: permission denied, mkdir '/usr/lib'")).toBe("permission");
    expect(of("npm ERR! nospc ENOSPC")).toBe("disk-full");
    expect(of("EBADPLATFORM: Unsupported platform for cli")).toBe("unsupported");
    expect(of("", null, { message: "spawn bash ENOENT", code: "ENOENT" })).toBe("not-found");
    expect(of("", null, { message: "timed out after 600s", killed: true })).toBe("timeout");
    expect(of("", null, { message: "cancelled", killed: true })).toBe("cancelled");
    expect(of("something else")).toBe("exit");
    // npm's lines for fetches that worked name the registry; they do not make a permission failure a registry one
    expect(of("npm http fetch GET 200 https://registry.npmjs.org/@x%2fcli 300ms (cache miss)\nnpm http cache @x/cli@https://registry.npmjs.org/x.tgz 1ms (cache hit)\nnpm error code EACCES")).toBe("permission");
  });
});

/** An exec that answers from a script of results and records what ran. */
function fakeExec(results: SetupRunResult[]) {
  const ran: string[][] = [];
  const exec: typeof runCommand = async (launch, args) => {
    ran.push([launch.file, ...args]);
    return results.shift() ?? { code: 0, output: "" };
  };
  return { ran, exec };
}

describe("the install step", () => {
  const deps = (over: Partial<Parameters<typeof runInstall>[0]>) => {
    const seen: EngineSetupProgress[] = [];
    return {
      seen,
      deps: {
        engineId: "x",
        installers: [SH, NPM],
        host: host(),
        detect: async () => ({ ready: false as boolean, error: "not found" }),
        report: (p: EngineSetupProgress) => void seen.push(p),
        signal: new AbortController().signal,
        ...over
      }
    };
  };

  it("skips everything when the CLI is already there", async () => {
    const { seen, deps: d } = deps({ detect: async () => ({ ready: true, version: "1.2.3" }) });
    const { exec, ran } = fakeExec([]);
    const end = await runInstall({ ...d, exec });
    expect(end).toMatchObject({ phase: "done", version: "1.2.3" });
    expect(ran).toEqual([]);
    expect(seen.map((p) => p.phase)).toEqual(["done"]);
  });

  it("falls from a failed installer to the next, and succeeds once detection confirms", async () => {
    let installed = false;
    const { exec, ran } = fakeExec([
      { code: 1, output: "curl: (6) Could not resolve host: x.dev" },
      { code: 0, output: "added 1 package" }
    ]);
    const { seen, deps: d } = deps({
      detect: async () => (installed ? { ready: true, version: "2.0.0" } : { ready: false }),
      exec
    });
    const probe = d.detect;
    d.detect = async () => {
      // the second installer's exit flips the machine
      installed = ran.length >= 2;
      return probe();
    };
    const end = await runInstall(d);
    expect(end).toMatchObject({ phase: "done", installer: "npm", version: "2.0.0" });
    expect(ran).toEqual([["bash", "-c", "curl -fsSL https://x.dev/install.sh | bash"], ["npm", "install", "-g", "--loglevel", "http", "@x/cli"]]);
    expect(seen.map((p) => `${p.phase}${p.installer ? `:${p.installer}` : ""}`)).toEqual(["running:script", "running:npm", "checking:npm", "done:npm"]);
  });

  it("says installed-but-not-found when the installer succeeded and detection still misses it", async () => {
    const { exec } = fakeExec([{ code: 0, output: "done" }, { code: 0, output: "done" }]);
    const { deps: d } = deps({ exec });
    const end = await runInstall(d);
    expect(end.phase).toBe("failed");
    expect(end.failure).toMatchObject({ kind: "not-on-path", message: "not found" });
    expect(end.failure).not.toHaveProperty("path");
  });

  it("names the file it found and what running it said when the installed CLI does not run", async () => {
    const { exec } = fakeExec([{ code: 0, output: "done" }]);
    const file = "C:\\Users\\a\\AppData\\Roaming\\npm\\codebuddy.cmd";
    const { deps: d } = deps({ installers: [NPM], exec, detect: async () => ({ ready: false, path: file, error: "UNKNOWN: spawn UNKNOWN" }) });
    const end = await runInstall(d);
    expect(end.failure).toEqual({ kind: "not-on-path", message: "UNKNOWN: spawn UNKNOWN", path: file });
  });

  it("keeps the failure's output tail and kind when nothing worked", async () => {
    const { exec } = fakeExec([
      { code: 1, output: "line1\ncurl: (6) Could not resolve host: x.dev" },
      { code: 1, output: "npm ERR! code EACCES\nnpm ERR! permission denied" }
    ]);
    const { deps: d } = deps({ exec });
    const end = await runInstall(d);
    expect(end).toMatchObject({ phase: "failed", installer: "npm", failure: { kind: "permission" } });
    expect(end.output).toContain("EACCES");
  });

  it("retries npm once in Tomrade's own folder when it cannot write the system's global one, and says so", async () => {
    const own = "/data/borrowed-node/global";
    const { exec, ran } = fakeExec([
      { code: 243, output: "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib/node_modules/@x" },
      { code: 0, output: "added 1 package" }
    ]);
    const { seen, deps: d } = deps({
      installers: [NPM],
      host: host({ env: { PATH: "/usr/bin", TOMRADE_NPM_PREFIX: own } }),
      // the locator reads TOMRADE_NPM_PREFIX: what landed there is found
      detect: async () => (ran.length >= 2 ? { ready: true, version: "2.0.0" } : { ready: false }),
      exec
    });
    const end = await runInstall(d);
    expect(ran).toEqual([
      ["npm", "install", "-g", "--loglevel", "http", "@x/cli"],
      ["npm", "install", "-g", "--loglevel", "http", "--prefix", own, "@x/cli"]
    ]);
    expect(end).toMatchObject({ phase: "done", installer: "npm", prefix: own, version: "2.0.0" });
    expect(seen.filter((p) => p.phase === "running").map((p) => p.prefix)).toEqual([undefined, own]);

    // once only: a second permission failure is the answer
    const twice = fakeExec([{ code: 1, output: "npm error code EACCES" }, { code: 1, output: "npm error code EACCES" }]);
    const again = await runInstall({ ...deps({ installers: [NPM], host: host({ env: { TOMRADE_NPM_PREFIX: own } }) }).deps, exec: twice.exec });
    expect(twice.ran).toHaveLength(2);
    expect(again).toMatchObject({ phase: "failed", prefix: own, failure: { kind: "permission" } });
  });

  it("streams the installer's latest lines and its start time before the run ends", async () => {
    let finish: (r: SetupRunResult) => void = () => {};
    const exec: typeof runCommand = (_launch, _args, opts) => {
      opts.onOutput?.("npm http fetch GET 200 https://registry.npmjs.org/@x%2fcli 300ms (cache miss)\n");
      return new Promise((resolve) => { finish = resolve; });
    };
    const { seen, deps: d } = deps({ installers: [NPM], exec });
    const end = runInstall(d);
    await new Promise((r) => setTimeout(r, 10));
    const live = seen.at(-1);
    expect(live).toMatchObject({ phase: "running", installer: "npm", output: expect.stringContaining("npm http fetch GET 200") });
    expect(live?.startedAt).toBeTypeOf("number");
    finish({ code: 1, output: "npm error code EACCES" });
    expect(await end).toMatchObject({ phase: "failed" });
  });

  it("says a silent run looks stalled, offers the mirror, and clears it once output comes", async () => {
    let speak: (text: string) => void = () => {};
    let finish: (r: SetupRunResult) => void = () => {};
    const exec: typeof runCommand = (_launch, _args, opts) => {
      speak = (text) => opts.onOutput?.(text);
      return new Promise((resolve) => { finish = resolve; });
    };
    const { seen, deps: d } = deps({ installers: [NPM], exec, stallMs: 20 });
    const end = runInstall(d);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.at(-1)).toMatchObject({ phase: "running", stalled: true, mirror: NPM_MIRROR });
    speak("npm http fetch GET 200 https://registry.npmjs.org/x 9000ms\n");
    expect(seen.at(-1)?.stalled).toBeUndefined();
    finish({ code: 0, output: "" });
    await end;
  });

  it("retries with the mirror by adding --registry to npm and nothing else, and offers no mirror again", async () => {
    const plain = fakeExec([{ code: 1, output: "npm error code ETIMEDOUT" }]);
    const first = await runInstall({ ...deps({ installers: [NPM] }).deps, exec: plain.exec });
    expect(first).toMatchObject({ phase: "failed", failure: { kind: "network" }, mirror: NPM_MIRROR });
    const viaMirror = fakeExec([{ code: 1, output: "npm error code ETIMEDOUT" }]);
    const second = await runInstall({ ...deps({ installers: [NPM] }).deps, exec: viaMirror.exec, registry: first.mirror });
    const [ran] = viaMirror.ran;
    const flag = ran!.indexOf("--registry");
    expect(ran![flag + 1]).toBe(NPM_MIRROR);
    expect(ran!.filter((_, i) => i !== flag && i !== flag + 1)).toEqual(plain.ran[0]);
    expect(second.mirror).toBeUndefined();
    // the registry is npm's only: a retry on it leaves the script installer out
    const onlyNpm = fakeExec([]);
    await runInstall({ ...deps({}).deps, exec: onlyNpm.exec, registry: NPM_MIRROR });
    expect(onlyNpm.ran.map((r) => r[0])).toEqual(["npm"]);
  });

  it("offers the mirror when npmjs answers the ping slowly, and never when npm uses another registry", async () => {
    let finish: (r: SetupRunResult) => void = () => {};
    const waiting: typeof runCommand = () => new Promise((resolve) => { finish = resolve; });
    const slow = deps({ installers: [NPM], exec: waiting, host: host({ pingRegistry: async () => ({ registry: "https://registry.npmjs.org/", ms: null }) }) });
    const end = runInstall(slow.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(slow.seen.at(-1)).toMatchObject({ phase: "running", mirror: NPM_MIRROR });
    finish({ code: 0, output: "" });
    await end;

    const exec: typeof runCommand = async () => (await new Promise((r) => setTimeout(r, 10)), { code: 1, output: "npm error code ETIMEDOUT" });
    const own = deps({ installers: [NPM], exec, host: host({ pingRegistry: async () => ({ registry: "https://npm.example.corp/", ms: 9000 }) }) });
    expect((await runInstall(own.deps)).mirror).toBeUndefined();
  });

  it("reports unsupported when no installer fits", async () => {
    const { deps: d } = deps({ installers: [PS] });
    const end = await runInstall(d);
    expect(end).toMatchObject({ phase: "failed", failure: { kind: "unsupported" } });
  });
});

describe("what a moving install says", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Push = { at: number; progress: EngineSetupProgress };
  /** Pushes of the same phase, installer and stage come at most once per pace. */
  const expectPaced = (pushes: Push[], ms: number) => {
    const same = (a: EngineSetupProgress, b: EngineSetupProgress) => a.phase === b.phase && a.installer === b.installer && a.stage === b.stage;
    for (let i = 1; i < pushes.length; i++) {
      if (same(pushes[i]!.progress, pushes[i - 1]!.progress)) expect(pushes[i]!.at - pushes[i - 1]!.at).toBeGreaterThanOrEqual(ms - 5);
    }
  };

  it("reads npm's and the scripts' own words for the stage they are at", () => {
    expect(stageOf("npm", "npm http fetch GET 200 https://registry.npmjs.org/@x%2fcli 300ms (cache miss)")).toBe("resolve");
    expect(stageOf("npm", "npm http fetch GET 200 https://registry.npmmirror.com/@x/cli/-/cli-1.0.0.tgz 900ms (cache miss)")).toBe("fetch");
    expect(stageOf("npm", "npm http cache @x/cli@https://registry.npmjs.org/@x/cli/-/cli-1.0.0.tgz 1ms (cache hit)")).toBe("fetch");
    expect(stageOf("npm", "npm warn deprecated glob@7.2.3")).toBeNull();
    expect(stageOf("brew", "==> Downloading https://ghcr.io/v2/homebrew/core/x/blobs/sha256:abc")).toBe("download");
    expect(stageOf("brew", "==> Pouring x--1.0.arm64_sonoma.bottle.tar.gz")).toBe("unpack");
    expect(stageOf("script", "Setting up Claude Code...")).toBe("link");
    expect(stageOf("script", "✔ Claude Code successfully installed!")).toBe("link");
    expect(stageOf("script", "Version: 2.0.0")).toBeNull();
  });

  it("says which installer of how many runs, why the last gave way, and npm's stages and packages — at a pace", async () => {
    const pushes: Push[] = [];
    let installed = false;
    let lines = 0;
    const exec: typeof runCommand = async (launch, _args, opts) => {
      if (launch.file === "bash") return { code: 1, output: "curl: (6) Could not resolve host: x.dev" };
      const say = (line: string) => (lines++, opts.onOutput?.(`${line}\n`));
      say("npm http fetch GET 200 https://registry.npmjs.org/@x%2fcli 120ms (cache miss)");
      await sleep(150);
      for (const n of [1, 2, 3]) {
        // A burst between fetches: output, not a stage of its own.
        for (let k = 0; k < 20; k++) say(`npm warn deprecated dep-${n}-${k}@1.0.0`);
        say(`npm http fetch GET 200 https://registry.npmjs.org/@x/cli/-/dep-${n}-1.0.0.tgz 300ms (cache miss)`);
        await sleep(150);
      }
      installed = true;
      return { code: 0, output: "added 3 packages in 1s" };
    };
    const end = await runInstall({
      engineId: "x",
      installers: [SH, NPM],
      host: host(),
      detect: async () => (installed ? { ready: true, version: "2.0.0" } : { ready: false }),
      report: paced((progress) => void pushes.push({ at: Date.now(), progress }), 100),
      signal: new AbortController().signal,
      exec
    });
    expect(end).toMatchObject({ phase: "done", installer: "npm", attempt: 2, attempts: 2 });
    const script = pushes.map((p) => p.progress).filter((p) => p.installer === "script" && p.phase === "running");
    expect(script[0]).toMatchObject({ attempt: 1, attempts: 2 });
    expect(script[0]?.previous).toBeUndefined();
    const npm = pushes.map((p) => p.progress).filter((p) => p.installer === "npm" && p.phase === "running");
    expect(npm[0]).toMatchObject({ attempt: 2, attempts: 2, previous: { installer: "script", kind: "network" } });
    expect(npm.map((p) => p.stage).filter((stage, i, all) => i === 0 || stage !== all[i - 1])).toEqual([undefined, "resolve", "fetch"]);
    const counts = npm.map((p) => p.packages ?? 0);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBe(3);
    expect(npm.at(-1)?.lastOutputAt).toBeTypeOf("number");
    // Every line was output; only a handful of pushes carried it.
    expect(lines).toBe(64);
    expect(pushes.length).toBeLessThan(16);
    expectPaced(pushes, 100);
  });

  it("pushes at once what the screen words differently, folds the rest into the latest, and never holds back the end", async () => {
    const sent: EngineSetupProgress[] = [];
    const push = paced((progress) => void sent.push(progress), 1000);
    const base: EngineSetupProgress = { engineId: "x", step: "install", phase: "running", installer: "npm" };
    push({ ...base, output: "1" });
    push({ ...base, output: "2" });
    push({ ...base, output: "3" });
    push({ ...base, stage: "fetch", output: "4" });
    push({ ...base, stage: "fetch", output: "5" });
    push({ ...base, phase: "done" });
    expect(sent.map((p) => p.output ?? p.phase)).toEqual(["1", "4", "done"]);
    await sleep(1100);
    expect(sent).toHaveLength(3);
  });
});

describe("the sign-in step", () => {
  it("is done at once when the person is already signed in", async () => {
    const seen: EngineSetupProgress[] = [];
    const end = await runSignIn({ engineId: "x", start: null, probe: async () => true, report: (p) => void seen.push(p), signal: new AbortController().signal });
    expect(end.phase).toBe("done");
  });

  it("catches the browser address from the login command and finishes when the probe turns true", async () => {
    const seen: EngineSetupProgress[] = [];
    let takeOutput: (text: string) => void = () => {};
    let settle: (r: SetupRunResult) => void = () => {};
    let signedIn = false;
    const end = runSignIn({
      engineId: "x",
      start: () => ({
        result: new Promise<SetupRunResult>((resolve) => { settle = resolve; }),
        onOutput: (take) => { takeOutput = take; }
      }),
      probe: async () => signedIn,
      report: (p) => void seen.push(p),
      signal: new AbortController().signal,
      pollMs: 20
    });
    await new Promise((r) => setTimeout(r, 30));
    takeOutput("Open this link to sign in:\nhttps://auth.example.com/device?code=abc\n");
    await new Promise((r) => setTimeout(r, 30));
    signedIn = true;
    settle({ code: 0, output: "" });
    expect(await end).toMatchObject({ phase: "done", url: "https://auth.example.com/device?code=abc" });
    expect(seen.some((p) => p.phase === "waiting" && p.url)).toBe(true);
    // the wait is timed from its start, and what the command printed shows beside it
    expect(seen.find((p) => p.url)).toMatchObject({ startedAt: seen[0]!.startedAt, output: expect.stringContaining("Open this link to sign in") });
    expect(seen[0]?.startedAt).toBeTypeOf("number");
  });

  it("fails with the command's own words when login exits badly and the probe stays false", async () => {
    const end = await runSignIn({
      engineId: "x",
      start: () => ({ result: Promise.resolve({ code: 1, output: "error: network unreachable" }), onOutput: () => {} }),
      probe: async () => false,
      report: () => {},
      signal: new AbortController().signal,
      pollMs: 10
    });
    expect(end).toMatchObject({ phase: "failed", failure: { kind: "network" } });
  });

  it("falls back to the terminal sign-in when an older CLI has no such login command", async () => {
    const seen: EngineSetupProgress[] = [];
    let signedIn = false;
    const end = runSignIn({
      engineId: "x",
      start: () => ({ result: Promise.resolve({ code: 1, output: "error: unknown command 'auth'\nUsage: claude [options] [command] [prompt]\n" }), onOutput: () => {} }),
      probe: async () => signedIn,
      report: (p) => void seen.push(p),
      signal: new AbortController().signal,
      pollMs: 10
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.at(-1)).toMatchObject({ phase: "waiting", terminal: true });
    signedIn = true;
    expect(await end).toMatchObject({ phase: "done" });
  });

  it("waits on the terminal sign-in, polling the probe, and can be cancelled", async () => {
    const seen: EngineSetupProgress[] = [];
    const abort = new AbortController();
    const end = runSignIn({ engineId: "x", start: null, probe: async () => false, report: (p) => void seen.push(p), signal: abort.signal, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 25));
    abort.abort();
    expect(await end).toMatchObject({ phase: "failed", failure: { kind: "cancelled" } });
    expect(seen[0]).toMatchObject({ phase: "waiting", terminal: true });
  });
});

describe("running one command for real", () => {
  it("keeps output, exits cleanly and stops on cancel", async () => {
    const signal = new AbortController().signal;
    const node = bareLaunch(process.execPath);
    const ok = await runCommand(node, ["-e", "console.log('hello'); process.exit(0)"], { signal, timeoutMs: 30_000 });
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.output).toContain("hello");

    const abort = new AbortController();
    const hung = runCommand(node, ["-e", "setInterval(() => {}, 1000)"], { signal: abort.signal, timeoutMs: 30_000 });
    setTimeout(() => abort.abort(), 200);
    const stopped = await hung;
    expect(stopped.code).toBeNull();
    expect(stopped.error?.killed).toBe(true);
  });
});

/** Whether a process is still there: signal 0 checks without sending anything. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("stopping a script installer on macOS and Linux", () => {
  // The shape of `curl … | bash`: a pipeline whose inner bash starts children of its own, each printing its pid.
  const installer = ["-c", "sleep 60 | bash -c 'echo $$; sleep 60 & echo $!; wait' & wait"];
  const pidsIn = (output: string) => output.split(/\s+/).filter(Boolean).map(Number);
  const gone = async (pids: number[]) => {
    for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
    return pids.filter(alive);
  };

  it("leaves nothing of it running once cancelled", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    const run = runCommand(bareLaunch("bash"), installer, { signal: abort.signal, timeoutMs: 30_000, onOutput: (text) => void seen.push(text) });
    while (pidsIn(seen.join("")).length < 2) await new Promise((r) => setTimeout(r, 20));
    const pids = pidsIn(seen.join(""));
    expect(pids.every(alive)).toBe(true);
    abort.abort();
    expect(await run).toMatchObject({ code: null, error: { message: "cancelled", killed: true } });
    expect(await gone(pids)).toEqual([]);
  });

  it("leaves nothing of it running once it times out", async () => {
    const result = await runCommand(bareLaunch("bash"), installer, { signal: new AbortController().signal, timeoutMs: 500 });
    expect(result.error).toMatchObject({ killed: true, message: expect.stringContaining("timed out") });
    const pids = pidsIn(result.output);
    expect(pids).toHaveLength(2);
    expect(await gone(pids)).toEqual([]);
  });
});
