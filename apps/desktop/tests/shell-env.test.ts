import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeShellEnv, readShellEnv } from "../src/shell-env.js";

// What launchd hands an app opened from Finder or the Dock.
const launchd = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x", SHELL: "/bin/zsh" };

describe("merging the login shell's environment", () => {
  it("puts the shell's PATH first and keeps the entries only the app had", () => {
    const env = mergeShellEnv({ ...launchd, PATH: "/usr/bin:/app/only" }, { PATH: "/opt/homebrew/bin:/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890" });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/app/only");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HOME).toBe("/Users/x");
  });

  it("leaves the shell session's own variables and Electron's switches behind", () => {
    const env = mergeShellEnv({ ...launchd, ELECTRON_RUN_AS_NODE: undefined }, { PWD: "/tmp", SHLVL: "2", _: "/usr/bin/env", ELECTRON_RUN_AS_NODE: "1", LANG: "en_US.UTF-8" });
    expect(env).not.toHaveProperty("PWD");
    expect(env).not.toHaveProperty("SHLVL");
    expect(env).not.toHaveProperty("_");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
  });
});

describe("reading a login shell", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-shell-env-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("sees what the profile exports, values with newlines included", async () => {
    fs.writeFileSync(path.join(home, ".profile"), `export PATH="/fixture/bin:$PATH"\nexport TOMRADE_TWO_LINES="a\nb"\necho noise from the profile\n`);
    const { env } = await readShellEnv("/bin/sh", { ...launchd, HOME: home, ENV: path.join(home, ".profile") });
    expect(env?.PATH?.split(":")[0]).toBe("/fixture/bin");
    expect(env?.TOMRADE_TWO_LINES).toBe("a\nb");
  });

  it("gives up on a shell that cannot run", async () => {
    expect(await readShellEnv(path.join(home, "no-such-shell"), launchd)).toMatchObject({ env: null, problem: "could not run (ENOENT)" });
  });

  // An interactive zsh ignores SIGTERM, so a gentler timeout never ended it.
  it.skipIf(!fs.existsSync("/bin/zsh"))("gives up on time on an rc file that waits for input", async () => {
    fs.writeFileSync(path.join(home, ".zshrc"), "read answer\n");
    const started = Date.now();
    const read = await readShellEnv("/bin/zsh", { ...launchd, HOME: home, ZDOTDIR: home }, 300);
    expect(read).toEqual({ env: null, problem: "did not answer within 0.3 s" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
