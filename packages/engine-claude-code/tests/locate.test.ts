import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CliLocator,
  cmdArgument,
  cmdLine,
  expandWindowsVars,
  fileNames,
  launchFor,
  machineHost,
  parseRegInstalls,
  parseRegPath,
  shimTarget,
  type CliHost
} from "../src/locate.js";

// A name nothing on this machine is installed as, since the known folders include real ones like /usr/local/bin.
const NAME = "tomrade-fake-cli";

function cli(dir: string, body: string, name = NAME, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode });
  return file;
}

function setup(opts: { path?: string[]; fresh?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const runs: string[] = [];
  const machine = machineHost();
  const host: CliHost = {
    platform: process.platform,
    arch: process.arch,
    env: { PATH: [...(opts.path ?? []), "/usr/bin", "/bin"].join(":"), HOME: home },
    home,
    freshPath: async () => opts.fresh ?? [],
    npmPrefix: async () => null,
    wsl: async () => null,
    installs: async () => [],
    run: (launch, args, timeoutMs) => {
      runs.push(launch.file);
      return machine.run(launch, args, timeoutMs);
    }
  };
  return { root, home, host, runs };
}

describe.skipIf(process.platform === "win32")("finding a local CLI", () => {
  it("takes the first file on PATH that answers --version, and remembers it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const first = cli(path.join(root, "a"), 'echo "fake-cli 1.2.3"');
    cli(path.join(root, "b"), 'echo "fake-cli 9.9.9"');
    const { host, runs } = setup({ path: [path.join(root, "a"), path.join(root, "b")] });
    const locator = new CliLocator(NAME, host);

    const status = await locator.locate();
    expect(status).toMatchObject({ state: "ready", path: first, source: "path", version: "1.2.3" });
    expect(runs).toEqual([first]);

    await locator.locate();
    expect(runs).toHaveLength(1);
    await locator.locate({ fresh: true });
    expect(runs).toHaveLength(2);
    expect((await locator.launch(NAME)).file).toBe(first);
  });

  it("prefers the path the person chose, and falls back with a note when it no longer runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const onPath = cli(path.join(root, "bin"), 'echo "fake-cli 1.0.0"');
    const chosen = cli(path.join(root, "chosen"), 'echo "fake-cli 2.0.0"');
    const { host } = setup({ path: [path.join(root, "bin")] });
    const locator = new CliLocator(NAME, host);

    expect(await locator.locate({ manual: chosen })).toMatchObject({ state: "ready", path: chosen, source: "manual", version: "2.0.0" });
    expect((await locator.launch(chosen)).file).toBe(chosen);

    fs.rmSync(chosen);
    const after = await locator.locate({ manual: chosen, fresh: true });
    expect(after).toMatchObject({ state: "ready", path: onPath, source: "path", manual: { path: chosen, error: "file not found" } });
    // A turn follows what detection settled on, not the stale choice.
    expect((await locator.launch(chosen)).file).toBe(onPath);
  });

  it("looks at PATH as a new terminal sees it, and hands those folders to the CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const later = path.join(root, "installed-later");
    const file = cli(later, 'echo "fake-cli 3.1.4"');
    const { host } = setup({ fresh: [later] });
    const locator = new CliLocator(NAME, host);

    const status = await locator.locate();
    expect(status).toMatchObject({ state: "ready", path: file, source: "login-path" });
    expect(status.searched).toContain(later);
    const launch = await locator.launch();
    expect(launch.env().PATH!.split(":")[0]).toBe(later);
  });

  it("finds an installer's folder that is on no PATH at all", async () => {
    const { host, home } = setup();
    const file = cli(path.join(home, ".local/bin"), 'echo "fake-cli 0.1.0"');
    expect(await new CliLocator(NAME, host).locate()).toMatchObject({ state: "ready", path: file, source: "known" });
  });

  it("finds the newest node of a version manager first", async () => {
    const { host, home } = setup();
    cli(path.join(home, ".nvm/versions/node/v18.20.0/bin"), 'echo "fake-cli 1.0.0"');
    const newest = cli(path.join(home, ".nvm/versions/node/v20.11.1/bin"), 'echo "fake-cli 2.0.0"');
    expect(await new CliLocator(NAME, host).locate()).toMatchObject({ path: newest, version: "2.0.0" });
  });

  it("tells a CLI that is there but does not run from one that is not there", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const broken = cli(path.join(root, "bin"), "echo boom >&2; exit 3");
    const { host } = setup({ path: [path.join(root, "bin")] });
    expect(await new CliLocator(NAME, host).locate()).toMatchObject({ state: "broken", path: broken, error: "exited with code 3: boom" });

    const empty = setup();
    const missing = await new CliLocator(NAME, empty.host).locate();
    expect(missing.state).toBe("missing");
    expect(missing.attempts).toEqual([]);
    expect(missing.searched).toContain(path.join(empty.home, ".local/bin"));
  });

  it("says why a CLI that hangs is passed over", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    cli(path.join(root, "bin"), "sleep 5");
    const { host } = setup({ path: [path.join(root, "bin")] });
    const status = await new CliLocator(NAME, host, 300).locate();
    expect(status).toMatchObject({ state: "broken", error: "did not answer --version within 0.3s" });
  });

  it("runs a copy bundled in a desktop app with that app's own runtime, after every folder a terminal searches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    // The app's binary acts as Node only when asked to, as Electron does.
    const runtime = cli(path.join(root, "App.app/Contents/MacOS"), '[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 9\nexec /bin/sh "$@"', "Electron");
    const file = cli(path.join(root, "App.app/Contents/Resources/cli/bin"), 'echo "2.137.1"');
    const gone = { file: path.join(root, "Gone.app/cli/bin", NAME), runtime: path.join(root, "Gone.app/Electron") };
    const { host } = setup();
    const locator = new CliLocator(NAME, host, undefined, () => [gone, { file, runtime }]);
    expect(await locator.locate()).toMatchObject({ state: "ready", path: file, source: "known", version: "2.137.1" });
    const launch = await locator.launch();
    expect(launch.argv(["--acp"])).toEqual({ command: runtime, args: [file, "--acp"] });
    expect(launch.env().ELECTRON_RUN_AS_NODE).toBe("1");
    // Chosen by hand, the same file still starts through its app.
    expect(await locator.check(file)).toEqual({ ok: true, path: file, version: "2.137.1" });
    // An app folder that holds no install is still listed as looked in.
    expect((await new CliLocator(NAME, host, undefined, async () => [gone]).locate()).searched).toContain(path.dirname(gone.file));

    const onPath = cli(path.join(root, "bin"), 'echo "2.155.0"');
    const first = setup({ path: [path.join(root, "bin")] });
    expect(await new CliLocator(NAME, first.host, undefined, () => [{ file, runtime }]).locate()).toMatchObject({ path: onPath, source: "path" });
  });

  it("runs an app's own launcher script as it is", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const launcher = cli(path.join(root, "App.app/Contents/Resources/runtime/cli/bin"), 'echo "0.40.2"');
    const { host } = setup();
    const locator = new CliLocator(NAME, host, undefined, () => [{ file: path.join(root, "Gone.app/runtime/cli/bin", NAME) }, { file: launcher }]);
    expect(await locator.locate()).toMatchObject({ state: "ready", path: launcher, source: "known", version: "0.40.2" });
    expect((await locator.launch()).argv(["--profile", "acp"])).toEqual({ command: launcher, args: ["--profile", "acp"] });
  });

  it("checks a picked file before it is saved", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-locate-"));
    const good = cli(path.join(root, "ok"), 'echo "2.0.14 (Claude Code)"');
    const plain = cli(path.join(root, "plain"), "echo hi", NAME, 0o644);
    const { host } = setup();
    const locator = new CliLocator(NAME, host);
    expect(await locator.check(good)).toEqual({ ok: true, path: good, version: "2.0.14" });
    expect(await locator.check(plain)).toMatchObject({ ok: false, error: "not executable (no execute permission)" });
    expect(await locator.check(path.join(root, "nope"))).toMatchObject({ ok: false, error: "file not found" });
    expect(await locator.check(root)).toMatchObject({ ok: false, error: "not a file" });
  });
});

describe("starting a CLI on Windows", () => {
  it("tries the runnable kinds PATHEXT lists, in its order", () => {
    expect(fileNames("codex", "win32", ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1")).toEqual(["codex.com", "codex.exe", "codex.bat", "codex.cmd"]);
    expect(fileNames("codex.cmd", "win32")).toEqual(["codex.cmd"]);
    expect(fileNames("codex", "darwin")).toEqual(["codex"]);
  });

  it("reads the script out of npm, pnpm and yarn shims", () => {
    const npm = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
    expect(shimTarget("C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd", npm)).toBe("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
    const pnpm = `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n`;
    expect(shimTarget("C:\\Users\\a\\AppData\\Local\\pnpm\\claude.CMD", pnpm)).toBe("C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
    const yarn = `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\codex.cmd" %*\r\n`;
    expect(shimTarget("C:\\Users\\a\\AppData\\Local\\Yarn\\bin\\codex.cmd", yarn)).toBe("C:\\Users\\a\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\.bin\\codex.cmd");
    expect(shimTarget("C:\\tools\\codex.bat", "@echo off\r\ncodex-real.exe %*\r\n")).toBeNull();
  });

  it("escapes arguments for cmd.exe the way a %* shim reads them back", () => {
    expect(cmdArgument("plain")).toBe('^^^"plain^^^"');
    expect(cmdArgument("50% & more")).toBe('^^^"50^^^%^^^ ^^^&^^^ more^^^"');
    expect(cmdArgument('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
    // Backslashes count only before a quote: doubled there, and at the end before the closing one.
    expect(cmdArgument("ends\\\\")).toBe('^^^"ends\\\\\\\\^^^"');
    expect(cmdArgument("C:\\dir\\file")).toBe('^^^"C:\\dir\\file^^^"');
    expect(cmdLine("C:\\Program Files\\x\\codex.cmd", ["--version"])).toBe('C:\\Program^ Files\\x\\codex.cmd ^^^"--version^^^"');
  });

  it("falls back to cmd.exe for a batch file it cannot read", () => {
    const launch = launchFor("C:\\nowhere\\codex.cmd", { platform: "win32", env: { Path: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
    expect(launch.argv(["--version"])).toEqual({ command: "C:\\Windows\\system32\\cmd.exe", args: ["/d", "/s", "/c", '"C:\\nowhere\\codex.cmd ^^^"--version^^^""'], verbatim: true });
    // Windows spells it Path; the CLI's folder goes first under the same key.
    expect(launch.env()).toEqual({ Path: "C:\\nowhere;C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" });
  });

  it("rebuilds PATH from the registry the way Windows composes it", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;%APPDATA%\\npm\r\n\r\n";
    const value = parseRegPath(out)!;
    expect(expandWindowsVars(value, { userprofile: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe("C:\\Users\\a\\.local\\bin;C:\\Users\\a\\AppData\\Roaming\\npm");
    expect(expandWindowsVars("%NOPE%\\bin", {})).toBe("%NOPE%\\bin");
    expect(parseRegPath("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
  });

  it("reads where an app was installed from the uninstall entries in the registry", () => {
    const out = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a1b2-c3",
      "    DisplayName    REG_SZ    WorkBuddy AI 1.4.0",
      "    InstallLocation    REG_SZ    D:\\软件\\WorkBuddy AI\\",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other",
      "    DisplayName    REG_SZ    Something Else",
      "    InstallLocation    REG_SZ    C:\\Other",
      "",
      "HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\wb",
      "    DisplayIcon    REG_SZ    \"E:\\Tools\\WB\\WorkBuddy.exe\",0",
      "    DisplayName    REG_SZ    WorkBuddy",
      "",
      "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\wb2",
      "    DisplayName    REG_SZ    WorkBuddy",
      "    UninstallString    REG_SZ    \"F:\\WB\\Uninstall WorkBuddy.exe\" /allusers",
      ""
    ].join("\r\n");
    expect(parseRegInstalls(out, /workbuddy/i)).toEqual(["D:\\软件\\WorkBuddy AI", "E:\\Tools\\WB", "F:\\WB"]);
    expect(parseRegInstalls("", /workbuddy/i)).toEqual([]);
  });
});
