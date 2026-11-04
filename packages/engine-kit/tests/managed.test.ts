import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeProgram } from "@tomradex/testkit";
import { CliLocator, machineHost, type CliHost } from "../src/locate.js";
import { binKind, managedLaunch, type ManagedCli } from "../src/managed.js";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-managed-"));
const write = (dir: string, name: string, body: string | Buffer, mode = 0o644) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode });
  return file;
};

describe("what a bin file is", () => {
  it("takes Windows, Linux and macOS programs for native ones, by their first bytes", () => {
    const dir = root();
    expect(binKind(write(dir, "claude.exe", Buffer.from([0x4d, 0x5a, 0x90, 0x00])))).toBe("native");
    expect(binKind(write(dir, "opencode", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])))).toBe("native");
    expect(binKind(write(dir, "codex", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c])))).toBe("native");
    expect(binKind(write(dir, "universal", Buffer.from([0xca, 0xfe, 0xba, 0xbe])))).toBe("native");
  });

  it("takes a .js name or a node shebang for a script, CodeBuddy's extensionless one too", () => {
    const dir = root();
    expect(binKind(write(dir, "codex.js", "require('./x')\n"))).toBe("node");
    expect(binKind(write(dir, "cli.mjs", "import './x.js'\n"))).toBe("node");
    expect(binKind(write(dir, "codebuddy", "#!/usr/bin/env node\nrequire('../dist')\n"))).toBe("node");
    expect(binKind(write(dir, "lowmem", "#!/usr/bin/env -S node --optimize-for-size\r\n"))).toBe("node");
  });

  it("takes anything else, and a file that is not there, for a placeholder", () => {
    const dir = root();
    expect(binKind(write(dir, "claude.exe", 'echo "Error: claude native binary not installed."\nexit 1\n'))).toBe("stub");
    expect(binKind(write(dir, "tool", "#!/bin/sh\necho hi\n"))).toBe("stub");
    expect(binKind(path.join(dir, "missing"))).toBe("stub");
  });
});

describe("how a managed copy starts", () => {
  const copy = (file: string, over: Partial<ManagedCli> = {}): ManagedCli => ({ file, version: "1.0.0", runtime: "/app/Tomrade Helper", nodeDir: "/data/agents/node", prefer: false, ...over });

  it("runs a script with the runtime as Node, the person's PATH first and Tomrade's node last", () => {
    const file = write(root(), "codex.js", "1");
    const launch = managedLaunch(copy(file, { env: { DISABLE_AUTOUPDATER: "1" } }), { platform: "darwin", env: {} })!;
    expect(launch.argv(["--version"])).toEqual({ command: "/app/Tomrade Helper", args: [file, "--version"] });
    const env = launch.env({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/h", PI_CODING_AGENT_DIR: "/data/pi" });
    expect(env.PATH).toBe([path.dirname(file), "/opt/homebrew/bin", "/usr/bin", "/data/agents/node"].join(":"));
    expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", DISABLE_AUTOUPDATER: "1", HOME: "/h" });
    // Built-in Pi's folder is its own; the person's Pi reads ~/.pi.
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("runs a native bin as itself, without the runtime's Node switch", () => {
    const file = write(root(), "claude", Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    const launch = managedLaunch(copy(file), { platform: "darwin", env: {} })!;
    expect(launch.argv(["-p"])).toEqual({ command: file, args: ["-p"] });
    expect(launch.env({ PATH: "/usr/bin" }).ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("has no way to start a placeholder", () => {
    expect(managedLaunch(copy(write(root(), "claude.exe", "echo missing\n")), { platform: "darwin", env: {} })).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("where the locator puts a managed copy", () => {
  const NAME = "tomrade-fake-managed-cli";
  const host = (dirs: string[], home: string): CliHost => ({
    ...machineHost(),
    env: { PATH: [...dirs, "/usr/bin", "/bin"].join(":"), HOME: home },
    home,
    freshPath: async () => [],
    npmPrefix: async () => null,
    wsl: async () => null,
    installs: async () => []
  });
  const setup = () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, "own"), { recursive: true });
    const own = fakeProgram(path.join(dir, "own", NAME), '#!/bin/sh\necho "own 1.0.0"\n');
    // Not executable: the runtime starts it, so it need not be.
    const managed = write(path.join(dir, "agents", "x", "2.0.0", "bin"), "cli.js", 'console.log("managed 2.0.0")\n');
    const copy = (prefer: boolean): ManagedCli => ({ file: managed, version: "2.0.0", runtime: process.execPath, nodeDir: path.join(dir, "agents", "node"), prefer });
    return { dir, own, managed, copy, home: path.join(dir, "home") };
  };

  it("uses it only where the person's own copy is missing, unless it is preferred", async () => {
    const { dir, own, managed, copy, home } = setup();
    const withOwn = new CliLocator(NAME, host([path.join(dir, "own")], home));
    withOwn.useManaged(copy(false));
    expect(await withOwn.locate()).toMatchObject({ state: "ready", path: own, source: "path" });

    const without = new CliLocator(NAME, host([], home));
    without.useManaged(copy(false));
    expect(await without.locate()).toMatchObject({ state: "ready", path: managed, source: "managed", version: "2.0.0" });
    const launch = await without.launch();
    expect(launch.argv(["--version"])).toEqual({ command: process.execPath, args: [managed, "--version"] });
  });

  it("puts a preferred copy ahead of PATH, but behind the path the person chose", async () => {
    const { dir, own, managed, copy, home } = setup();
    const locator = new CliLocator(NAME, host([path.join(dir, "own")], home));
    locator.useManaged(copy(true));
    expect(await locator.locate()).toMatchObject({ path: managed, source: "managed" });
    expect(await locator.locate({ manual: own })).toMatchObject({ path: own, source: "manual" });
    // Taken away, the next look finds the person's own again without waiting out the cache.
    locator.useManaged(null);
    expect(await locator.locate()).toMatchObject({ path: own, source: "path" });
  });
});
