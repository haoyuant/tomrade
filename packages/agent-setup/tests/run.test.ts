import { describe, expect, it } from "vitest";
import type { EngineInstaller, EngineSetupProgress } from "@tomradex/agent";
import {
  applicableInstallers,
  bareLaunch,
  classifyFailure,
  installerLaunch,
  runCommand,
  runInstall,
  runSignIn,
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
});

describe("how one installer runs", () => {
  it("runs npm install -g through the npm the machine answers with, and fails concretely without one", async () => {
    const launch = await installerLaunch(NPM, host());
    expect("launch" in launch && launch.args).toEqual(["install", "-g", "@x/cli"]);
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
    expect(ran).toEqual([["bash", "-c", "curl -fsSL https://x.dev/install.sh | bash"], ["npm", "install", "-g", "@x/cli"]]);
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

  it("reports unsupported when no installer fits", async () => {
    const { deps: d } = deps({ installers: [PS] });
    const end = await runInstall(d);
    expect(end).toMatchObject({ phase: "failed", failure: { kind: "unsupported" } });
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
