import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProgram } from "@tomradex/testkit";
import { fishFile, launcherText, placeCommand, profileBlock, withoutBlock, type CommandPlace, type Runner } from "../src/tomrade-command.js";

const roots: string[] = [];
function tempDir(): string {
  // A space and a quote in every path, as "Application Support" has one and a person's name may have the other.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade cmd's-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A machine of its own: a home, Tomrade's folder for the command, and a runtime that says what it was run with. */
function machine(over: Partial<CommandPlace> = {}): CommandPlace {
  const root = tempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const runtime = path.join(root, "runtime");
  const runnable = fakeProgram(runtime, `#!/bin/sh\nprintf '%s\\n' "node=$ELECTRON_RUN_AS_NODE" "config=$TOMRADE_CLI_CONFIG" "$@"\n`);
  return {
    platform: "darwin",
    home,
    shell: "/bin/zsh",
    pathDirs: ["/usr/bin", "/bin"],
    dir: path.join(root, "Application Support", "Tomrade", "cli"),
    runtime: runnable,
    script: path.join(root, "app", "dist", "tomrade-cli.js"),
    config: { url: "http://127.0.0.1:19090", open: "/Applications/Tomrade.app", locale: "en" },
    ...over
  };
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
/** The files under a folder that mention the command's block. */
const mentioning = (dir: string) => {
  try {
    return execFileSync("grep", ["-rl", "tomrade command", dir], { encoding: "utf8" });
  } catch {
    return "";
  }
};
/** What PATH a POSIX shell ends up with after reading the file, twice over as nested shells do. */
const pathAfter = (file: string) => execFileSync("/bin/sh", ["-c", `PATH=/usr/bin:/bin; . "$1"; . "$1"; printf '%s' "$PATH"`, "sh", file], { encoding: "utf8" });

describe("the tomrade command on PATH", () => {
  it("writes a launcher that runs the app's binary as Node on the command's script, whatever the paths hold", async () => {
    const place = machine();
    await placeCommand(true, place);
    const launcher = path.join(place.dir, "tomrade");
    expect(fs.statSync(launcher).mode & 0o111).toBeTruthy();
    const ran = execFileSync(launcher, ["term", "--agent", "it's me", "TOM-1"], { encoding: "utf8" }).split("\n");
    expect(ran.slice(0, 6)).toEqual(["node=1", `config=${path.join(place.dir, "cli.json")}`, place.script, "term", "--agent", "it's me"]);
    expect(JSON.parse(read(path.join(place.dir, "cli.json"))!)).toEqual(place.config);
    // A file just written is checked by the system on its first run: slow on a busy machine.
  }, 20_000);

  it("links it into ~/.local/bin when that is on PATH, and changes nothing when run again", async () => {
    const place = machine();
    const bin = path.join(place.home, ".local", "bin");
    place.pathDirs = [...place.pathDirs, bin];
    expect(await placeCommand(true, place)).toEqual({ how: "link", where: [path.join(bin, "tomrade")] });
    expect(fs.readlinkSync(path.join(bin, "tomrade"))).toBe(path.join(place.dir, "tomrade"));
    expect(read(path.join(place.home, ".zshrc"))).toBeNull();
    const before = fs.statSync(path.join(place.dir, "tomrade")).mtimeMs;
    await placeCommand(true, place);
    expect(fs.statSync(path.join(place.dir, "tomrade")).mtimeMs).toBe(before);
    // Run through the link, as the shell finds it.
    expect(execFileSync(path.join(bin, "tomrade"), ["term"], { encoding: "utf8" })).toContain("term");
  }, 20_000);

  it("adds Tomrade's folder to PATH in zsh's file when ~/.local/bin is not on it, keeping what the file had", async () => {
    const place = machine();
    const rc = path.join(place.home, ".zshrc");
    fs.writeFileSync(rc, "alias ll='ls -l'");
    expect(await placeCommand(true, place)).toEqual({ how: "profile", where: [rc] });
    await placeCommand(true, place);
    const text = read(rc)!;
    expect(text.startsWith("alias ll='ls -l'\n# >>> tomrade command >>>")).toBe(true);
    expect(text.split("# >>> tomrade command >>>").length).toBe(2);
    expect(pathAfter(rc)).toBe(`/usr/bin:/bin:${place.dir}`);
    // ZDOTDIR, when set, is where zsh reads it.
    const zdot = machine({ zdotdir: path.join(tempDir(), "zsh") });
    await placeCommand(true, zdot);
    expect(read(path.join(zdot.zdotdir!, ".zshrc"))).toContain(zdot.dir);
  });

  it("puts bash's block in its rc file and in the login file it reads, never making one that would hide another", async () => {
    const place = machine({ shell: "/bin/bash", platform: "linux" });
    fs.writeFileSync(path.join(place.home, ".profile"), "export EDITOR=vi\n");
    expect((await placeCommand(true, place)).where).toEqual([path.join(place.home, ".bashrc"), path.join(place.home, ".profile")]);
    expect(fs.existsSync(path.join(place.home, ".bash_profile"))).toBe(false);
    expect(read(path.join(place.home, ".profile"))).toBe(`export EDITOR=vi\n${profileBlock(place.dir)}`);
    // fish reads a file of its own.
    const fish = machine({ shell: "/opt/homebrew/bin/fish" });
    await placeCommand(true, fish);
    expect(read(path.join(fish.home, ".config", "fish", "conf.d", "tomrade.fish"))).toBe(fishFile(fish.dir));
  });

  it("leaves someone else's tomrade in ~/.local/bin alone and uses the shell's file instead", async () => {
    const place = machine();
    const bin = path.join(place.home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tomrade"), "#!/bin/sh\necho other\n");
    place.pathDirs = [...place.pathDirs, bin];
    expect((await placeCommand(true, place)).how).toBe("profile");
    expect(read(path.join(bin, "tomrade"))).toBe("#!/bin/sh\necho other\n");
    await placeCommand(false, place);
    expect(read(path.join(bin, "tomrade"))).toBe("#!/bin/sh\necho other\n");
  });

  it("moves from the shell's file to the link once ~/.local/bin is on PATH", async () => {
    const place = machine();
    await placeCommand(true, place);
    expect(read(path.join(place.home, ".zshrc"))).toContain("tomrade command");
    place.pathDirs = [...place.pathDirs, path.join(place.home, ".local", "bin")];
    expect((await placeCommand(true, place)).how).toBe("link");
    // It made the file for the block alone, so the file goes with it.
    expect(read(path.join(place.home, ".zshrc"))).toBeNull();
  });

  it("takes everything of it off when turned off: the link, every block, the fish file and its own folder; the rest stays", async () => {
    const place = machine();
    const bin = path.join(place.home, ".local", "bin");
    fs.writeFileSync(path.join(place.home, ".bashrc"), "export A=1\n");
    // Each shell the person used left its own, and ~/.local/bin came on PATH since: all of them at once.
    await placeCommand(true, { ...place, shell: "/bin/bash" });
    await placeCommand(true, { ...place, shell: "/usr/bin/fish" });
    await placeCommand(true, place);
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(place.dir, "tomrade"), path.join(bin, "tomrade"));
    fs.symlinkSync(path.join(place.dir, "tomrade"), path.join(bin, "tomrade-again"));
    expect(mentioning(place.home).trim().split("\n").sort()).toEqual([".bash_profile", ".bashrc", ".zshrc"].map((f) => path.join(place.home, f)));
    expect(fs.existsSync(path.join(place.home, ".config", "fish", "conf.d", "tomrade.fish"))).toBe(true);
    const off = await placeCommand(false, place);
    expect(off.how).toBe("off");
    expect(fs.existsSync(path.join(bin, "tomrade"))).toBe(false);
    expect(fs.existsSync(place.dir)).toBe(false);
    expect(read(path.join(place.home, ".bashrc"))).toBe("export A=1\n");
    expect(read(path.join(place.home, ".bash_profile"))).toBeNull();
    expect(fs.existsSync(path.join(place.home, ".config", "fish", "conf.d", "tomrade.fish"))).toBe(false);
    // Nothing of Tomrade's is left in any file a shell reads.
    expect(mentioning(place.home)).toBe("");
    // A link the person made themselves is theirs.
    expect(fs.lstatSync(path.join(bin, "tomrade-again")).isSymbolicLink()).toBe(true);
    expect(await placeCommand(false, place)).toEqual({ how: "off", where: [] });
  });

  it("puts Tomrade's folder on the Windows user PATH once, and takes it off only once it was put there", async () => {
    const calls: { file: string; on: string | undefined; dir: string | undefined }[] = [];
    const run: Runner = async (file, _args, env) => void calls.push({ file, on: env.TOMRADE_CLI_ON, dir: env.TOMRADE_CLI_DIR });
    const place = machine({ platform: "win32", runtime: "C:\\Program Files\\Tomrade\\Tomrade.exe", script: "C:\\Program Files\\Tomrade\\resources\\app.asar\\dist\\tomrade-cli.js" });
    expect(await placeCommand(false, place, run)).toEqual({ how: "off", where: [] });
    expect(calls).toEqual([]);
    expect((await placeCommand(true, place, run)).how).toBe("userPath");
    await placeCommand(true, place, run);
    expect(calls).toEqual([{ file: "powershell.exe", on: "1", dir: place.dir }]);
    const cmd = read(path.join(place.dir, "tomrade.cmd"))!;
    expect(cmd.split("\r\n")).toEqual([
      "@echo off",
      expect.stringContaining("rem The tomrade command"),
      "setlocal",
      `set "TOMRADE_CLI_CONFIG=${path.join(place.dir, "cli.json")}"`,
      "set ELECTRON_RUN_AS_NODE=1",
      `"${place.runtime}" "${place.script}" %*`,
      ""
    ]);
    await placeCommand(false, place, run);
    expect(calls.at(-1)).toEqual({ file: "powershell.exe", on: "0", dir: place.dir });
    expect(fs.existsSync(place.dir)).toBe(false);
  });

  it("starts an AppImage that is not running and runs again once it rewrote the launcher", () => {
    const place = machine({ platform: "linux", runtime: "/tmp/.mount_TomradeX/tomrade", appImage: "/home/me/Tomrade.AppImage" });
    const text = launcherText(place);
    expect(text).toContain(`if [ ! -x '/tmp/.mount_TomradeX/tomrade' ]; then`);
    expect(text).toContain(`'/home/me/Tomrade.AppImage' >/dev/null 2>&1 &`);
    expect(text).toContain("Tomrade did not start.");
    expect(execFileSync("/bin/sh", ["-n", "-c", text])).toBeDefined();
  });

  it("takes out only its own block", () => {
    const block = profileBlock("/x");
    expect(withoutBlock(`a\n${block}b\n`)).toBe("a\nb\n");
    expect(withoutBlock("a\nb\n")).toBe("a\nb\n");
  });
});
