import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { machineHost, probeGit, runGitInstall, type GitInstallProgress, type GitStatus, type MachineHost, type RunOptions, type RunResult } from "../src/git.js";

vi.mock("node:child_process", async (actual) => {
  const real = await actual<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

interface FakeMachine {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Executable files on the fake disk. */
  files?: string[];
  /** Answers by "<file> <args...>"; a function sees each call, with its options. */
  runs?: Record<string, RunResult | ((options?: RunOptions) => RunResult | Promise<RunResult>)>;
}

function fakeHost(machine: FakeMachine): MachineHost & { adopted: string[]; ran: string[] } {
  const files = new Set(machine.files ?? []);
  const adopted: string[] = [];
  const ran: string[] = [];
  return {
    platform: machine.platform ?? "linux",
    env: machine.env ?? {},
    adopted,
    ran,
    async run(file, args, _timeoutMs, options) {
      const key = [file, ...args].join(" ");
      ran.push(key);
      const answer = machine.runs?.[key];
      if (!answer) return { code: null, output: "", error: `spawn ${file} ENOENT` };
      return typeof answer === "function" ? answer(options) : answer;
    },
    executable: async (file) => files.has(file),
    adoptPath: (dir) => void adopted.push(dir),
    wait: async () => {}
  };
}

const bin = (...parts: string[]) => path.join(...parts);

describe("probeGit", () => {
  it("finds a git on PATH and reads its version", async () => {
    const host = fakeHost({
      env: { PATH: "/usr/bin" },
      files: [bin("/usr/bin", "git")],
      runs: { [`${bin("/usr/bin", "git")} --version`]: { code: 0, output: "git version 2.44.0\n" } }
    });
    expect(await probeGit(host)).toEqual({ state: "ready", path: bin("/usr/bin", "git"), version: "2.44.0" });
  });

  it("is missing when nothing on PATH or the known folders has git", async () => {
    const host = fakeHost({ env: { PATH: "/usr/bin" } });
    expect((await probeGit(host)).state).toBe("missing");
  });

  it("never runs Apple's shim without the Command Line Tools, and offers xcode-select", async () => {
    const host = fakeHost({
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      files: ["/usr/bin/git"],
      runs: { "/usr/bin/xcode-select -p": { code: 2, output: "xcode-select: error: unable to get active developer directory\n" } }
    });
    expect(await probeGit(host)).toEqual({ state: "missing", installer: "xcode-select" });
    expect(host.ran).not.toContain("/usr/bin/git --version");
  });

  it("runs the shim once the Command Line Tools answer", async () => {
    const host = fakeHost({
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      files: ["/usr/bin/git"],
      runs: {
        "/usr/bin/xcode-select -p": { code: 0, output: "/Library/Developer/CommandLineTools\n" },
        "/usr/bin/git --version": { code: 0, output: "git version 2.39.5 (Apple Git-154)\n" }
      }
    });
    expect(await probeGit(host)).toMatchObject({ state: "ready", version: "2.39.5", installer: "xcode-select" });
  });

  it("reports a found git that does not answer, with its words", async () => {
    const host = fakeHost({
      env: { PATH: "/usr/bin" },
      files: [bin("/usr/bin", "git")],
      runs: { [`${bin("/usr/bin", "git")} --version`]: { code: 127, output: "error: libpcre missing\n" } }
    });
    expect(await probeGit(host)).toMatchObject({ state: "broken", error: "error: libpcre missing" });
  });

  it("finds git in an installer's folder off PATH and adopts that folder", async () => {
    const file = bin("C:\\Program Files", "Git", "cmd", "git.exe");
    const host = fakeHost({
      platform: "win32",
      env: { PATH: bin("C:\\Windows"), ProgramFiles: "C:\\Program Files" },
      files: [file],
      runs: { [`${file} --version`]: { code: 0, output: "git version 2.44.0.windows.1\n" } }
    });
    expect(await probeGit(host)).toMatchObject({ state: "ready", version: "2.44.0.windows.1" });
    expect(host.adopted).toEqual([path.dirname(file)]);
  });

  it("offers winget only when it is there", async () => {
    const winget = bin("C:\\Users\\t\\AppData\\Local", "Microsoft", "WindowsApps", "winget.exe");
    const with_ = fakeHost({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" }, files: [winget] });
    expect((await probeGit(with_)).installer).toBe("winget");
    const without = fakeHost({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" } });
    expect((await probeGit(without)).installer).toBeUndefined();
  });

  it("takes a configured binary at its word", async () => {
    const host = fakeHost({ runs: { "/opt/git/bin/git --version": { code: 0, output: "git version 2.50.0\n" } } });
    expect(await probeGit(host, "/opt/git/bin/git")).toMatchObject({ state: "ready", version: "2.50.0" });
  });
});

function installDeps(host: MachineHost, answers: GitStatus[]) {
  const seen: GitInstallProgress[] = [];
  const probes = [...answers];
  return {
    seen,
    deps: {
      host,
      probe: async () => probes.length > 1 ? probes.shift()! : probes[0]!,
      report: (p: GitInstallProgress) => void seen.push(p),
      signal: new AbortController().signal,
      pollMs: 0,
      timeoutMs: 1_000
    }
  };
}

describe("runGitInstall", () => {
  it("opens the macOS dialog, waits, and ends once git answers", async () => {
    const host = fakeHost({ platform: "darwin", runs: { "/usr/bin/xcode-select --install": { code: 0, output: "install requested\n" } } });
    const { deps, seen } = installDeps(host, [{ state: "missing" }, { state: "missing" }, { state: "ready", version: "2.39.5" }]);
    expect(await runGitInstall("xcode-select", deps)).toEqual({ phase: "done" });
    expect(seen.map((p) => p.phase)).toEqual(["running", "waiting", "done"]);
  });

  it("hands over what xcode-select said when it refuses", async () => {
    const host = fakeHost({ platform: "darwin", runs: { "/usr/bin/xcode-select --install": { code: 1, output: "xcode-select: error: command line tools are already installed\n" } } });
    const { deps } = installDeps(host, [{ state: "missing" }]);
    const end = await runGitInstall("xcode-select", deps);
    expect(end).toMatchObject({ phase: "failed", kind: "exit", message: "xcode-select: error: command line tools are already installed" });
  });

  it("gives up waiting after the time runs out", async () => {
    const host = fakeHost({ platform: "darwin", runs: { "/usr/bin/xcode-select --install": { code: 0, output: "" } } });
    const { deps } = installDeps(host, [{ state: "missing" }]);
    deps.timeoutMs = 1;
    expect((await runGitInstall("xcode-select", deps)).kind).toBe("timeout");
  });

  it("stops when cancelled", async () => {
    const host = fakeHost({ platform: "darwin", runs: { "/usr/bin/xcode-select --install": { code: 0, output: "" } } });
    const { deps } = installDeps(host, [{ state: "missing" }]);
    const abort = new AbortController();
    deps.signal = abort.signal;
    abort.abort();
    expect((await runGitInstall("xcode-select", deps)).kind).toBe("cancelled");
  });

  it("runs winget to its end and checks git answers", async () => {
    const host = fakeHost({
      platform: "win32",
      runs: { "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements": { code: 0, output: "Successfully installed\n" } }
    });
    const { deps } = installDeps(host, [{ state: "ready", version: "2.44.0" }]);
    expect(await runGitInstall("winget", deps)).toEqual({ phase: "done" });
  });

  it("shows winget's own words when the install fails", async () => {
    const host = fakeHost({
      platform: "win32",
      runs: { "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements": { code: 1, output: "No package found matching input criteria.\n" } }
    });
    const { deps } = installDeps(host, [{ state: "missing" }]);
    expect(await runGitInstall("winget", deps)).toMatchObject({ phase: "failed", message: "No package found matching input criteria." });
  });

  const WINGET_ARGS = "install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements";

  it("runs the winget it found, not whatever the bare name resolves to", async () => {
    const winget = bin("C:\\Users\\t\\AppData\\Local", "Microsoft", "WindowsApps", "winget.exe");
    const host = fakeHost({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" },
      files: [winget],
      runs: { [`${winget} ${WINGET_ARGS}`]: { code: 0, output: "Successfully installed\n" } }
    });
    const { deps } = installDeps(host, [{ state: "ready", version: "2.44.0" }]);
    expect(await runGitInstall("winget", deps)).toEqual({ phase: "done" });
    expect(host.ran).toEqual([`${winget} ${WINGET_ARGS}`]);
  });

  it("shows winget's newest line while it runs, without its progress bars' redraws or spinner", async () => {
    let finish!: () => void;
    const host = fakeHost({
      platform: "win32",
      runs: {
        [`winget ${WINGET_ARGS}`]: async (options) => {
          options?.onOutput?.("Found Git [Git.Git] Version 2.55.0\r\n");
          options?.onOutput?.("\x1b[2K  -\b\\\b|\b/");
          options?.onOutput?.("\r  ██████▒▒▒▒▒▒  20.0 MB / 66.0 MB\r  ████████████  66.0 MB / 66.0 MB\r\n");
          options?.onOutput?.("Starting package install...\r\n  -\b\\");
          await new Promise<void>((resolve) => (finish = resolve));
          return { code: 0, output: "" };
        }
      }
    });
    const { deps, seen } = installDeps(host, [{ state: "ready" }]);
    const end = runGitInstall("winget", deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.map((p) => p.line)).toEqual([undefined, "Found Git [Git.Git] Version 2.55.0", "████████████  66.0 MB / 66.0 MB", "Starting package install..."]);
    expect(seen.every((p) => p.phase === "running")).toBe(true);
    finish();
    expect(await end).toEqual({ phase: "done" });
  });

  it("stops winget when cancelled, and ends as cancelled rather than failed", async () => {
    let stopped = false;
    const host = fakeHost({
      platform: "win32",
      runs: {
        [`winget ${WINGET_ARGS}`]: (options) =>
          new Promise((resolve) =>
            options?.signal?.addEventListener("abort", () => {
              stopped = true;
              resolve({ code: 1, output: "", error: "cancelled" });
            })
          )
      }
    });
    const { deps } = installDeps(host, [{ state: "missing" }]);
    const abort = new AbortController();
    deps.signal = abort.signal;
    const end = runGitInstall("winget", deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    expect(await end).toEqual({ phase: "failed", kind: "cancelled" });
    expect(stopped).toBe(true);
  });
});

describe("machineHost", () => {
  it("streams a command's output as it comes and kills it on abort", async () => {
    const abort = new AbortController();
    const pieces: string[] = [];
    const result = await machineHost().run(process.execPath, ["-e", "console.log('working'); setInterval(() => {}, 1000)"], 30_000, {
      signal: abort.signal,
      onOutput: (text) => {
        pieces.push(text);
        abort.abort();
      }
    });
    expect(pieces.join("")).toContain("working");
    expect(result).toMatchObject({ error: "cancelled" });
    // No console window flashes up on Windows from the GUI app.
    expect(vi.mocked(spawn).mock.calls[0]![2]).toMatchObject({ windowsHide: true });
  });
});
