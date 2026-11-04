import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CliLaunch, ManagedCli } from "@tomradex/engine-kit";
import { installArgs, managedBin, ManagedCopies, nativeSpec, npmrcOf, parseNpmConfig } from "../src/managed.js";
import { bareLaunch, runInstall, type SetupHost, type runCommand } from "../src/run.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-managed-setup-"));

/** An installed version as npm leaves it: the package's manifest and its bin. */
function installed(prefix: string, pkg: string, bin: Record<string, string>, files: Record<string, string>) {
  const root = path.join(prefix, "node_modules", ...pkg.split("/"));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: pkg, bin }));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

describe("the npm settings a managed install keeps", () => {
  it("keeps only how to reach the registry, never what to skip", () => {
    const values = parseNpmConfig("registry=https://registry.npmmirror.com/\nproxy=null\nhttps-proxy=http://127.0.0.1:7890\ncafile=null\nstrict-ssl=false\nignore-scripts=true\n");
    expect(values).toEqual({ registry: "https://registry.npmmirror.com/", "https-proxy": "http://127.0.0.1:7890", "strict-ssl": "false" });
    expect(npmrcOf({ ...values, omit: "optional" })).toBe("registry=https://registry.npmmirror.com/\nhttps-proxy=http://127.0.0.1:7890\nstrict-ssl=false\nupdate-notifier=false\n");
  });
});

describe("the install command and its environment", () => {
  it("runs the bundled npm on Tomrade's runtime into the version's folder, past the person's npm settings", async () => {
    const dir = temp();
    const npmCli = path.join(dir, "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, "");
    const managed = new ManagedCopies({ dir: path.join(dir, "agents"), runtime: "/app/Tomrade Helper", npmCli, electron: "43.4.0" }, "darwin", () => {});
    const npm = managed.npm(bareLaunch("npm"))!;
    const prefix = managed.prefix("codex", "0.163.0");
    const npmrc = { user: path.join(prefix, ".tomrade-npmrc"), global: path.join(prefix, ".tomrade-npmrc-global") };
    const runs: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: typeof runCommand = async (launch, args, opts) => {
      runs.push({ ...launch.argv(args), env: launch.env(opts.env) });
      return { code: 0, output: "added 2 packages" };
    };
    const host: SetupHost = { platform: "darwin", env: { PATH: "/usr/local/bin:/usr/bin", npm_config_ignore_scripts: "true", NPM_CONFIG_OMIT: "optional", HOME: "/h" }, answers: async () => false, npm: async () => null };
    let detected = 0;
    const end = await runInstall({
      engineId: "codex",
      installers: [{ kind: "npm", package: "@openai/codex" }],
      host,
      resolve: async (_installer, registry) => ({ launch: managed.installing(npm), args: installArgs({ package: "@openai/codex", version: "0.163.0", prefix, npmrc, ...(registry ? { registry } : {}) }) }),
      detect: async () => (detected++ ? { ready: true, version: "0.163.0" } : { ready: false }),
      report: () => {},
      signal: new AbortController().signal,
      registry: "https://registry.npmmirror.com",
      exec
    });
    expect(end).toMatchObject({ phase: "done", version: "0.163.0" });
    expect(runs).toHaveLength(1);
    const [install] = runs;
    expect(install.command).toBe("/app/Tomrade Helper");
    expect(install.args).toEqual([
      npmCli, "install", "--prefix", prefix, "@openai/codex@0.163.0",
      "--no-audit", "--no-fund", "--foreground-scripts", "--include=optional",
      "--userconfig", npmrc.user, "--globalconfig", npmrc.global,
      "--loglevel", "http", "--registry", "https://registry.npmmirror.com"
    ]);
    // The person's ignore-scripts and omit=optional would leave a native agent as its placeholder.
    expect(Object.keys(install.env).filter((key) => /^npm_config_/i.test(key) && !["npm_config_runtime", "npm_config_target", "npm_config_disturl"].includes(key))).toEqual([]);
    expect(install.env).toMatchObject({
      PATH: `${path.join(dir, "agents", "node")}:/usr/local/bin:/usr/bin`,
      ELECTRON_RUN_AS_NODE: "1",
      npm_config_runtime: "electron",
      npm_config_target: "43.4.0",
      npm_config_disturl: "https://electronjs.org/headers",
      HOME: "/h"
    });
  });

  it("falls back to the machine's npm when the bundled one is not there, with the same environment", () => {
    const managed = new ManagedCopies({ dir: "/data/agents", runtime: "/app/rt", npmCli: "/nowhere/npm-cli.js" }, "linux", () => {});
    const npm = managed.npm(bareLaunch("npm"))!;
    expect(npm.argv(["install"])).toEqual({ command: "npm", args: ["install"] });
    expect(managed.installing(npm).env({ PATH: "/usr/bin", npm_config_prefix: "/usr" })).toEqual({ PATH: `${path.join("/data/agents", "node")}:/usr/bin`, ELECTRON_RUN_AS_NODE: "1" });
  });

  it("writes a node shim that runs the runtime as Node", () => {
    const dir = temp();
    new ManagedCopies({ dir, runtime: "/app/Tomrade Helper" }, "darwin", () => {}).start();
    const shim = fs.readFileSync(path.join(dir, "node", "node"), "utf8");
    expect(shim).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(shim).toContain('exec "/app/Tomrade Helper" "$@"');
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "node", "node")).mode & 0o111).toBeTruthy();
  });

  it("writes node.cmd and, for Git Bash, an sh `node` beside it on Windows", () => {
    const dir = temp();
    new ManagedCopies({ dir, runtime: "C:\\Program Files\\Tomrade\\Tomrade.exe" }, "win32", () => {}).start();
    expect(fs.readFileSync(path.join(dir, "node", "node.cmd"), "utf8")).toContain('"C:\\Program Files\\Tomrade\\Tomrade.exe" %*');
    const sh = fs.readFileSync(path.join(dir, "node", "node"), "utf8");
    expect(sh).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(sh).toContain('exec "C:/Program Files/Tomrade/Tomrade.exe" "$@"');
  });
});

describe("the size shown before installing", () => {
  it("adds this platform's native package to the package's own size", async () => {
    const asked: string[][] = [];
    const exec: typeof runCommand = async (_launch, args) => {
      asked.push(args);
      if (args[1] === "@openai/codex@latest") return { code: 0, output: JSON.stringify({ version: "0.163.0", "dist.unpackedSize": 13206, optionalDependencies: { "@openai/codex-linux-x64": "npm:@openai/codex@0.163.0-linux-x64", "@openai/codex-darwin-arm64": "npm:@openai/codex@0.163.0-darwin-arm64" } }) };
      return { code: 0, output: "npm warn something\n340793950\n" };
    };
    const managed = new ManagedCopies({ dir: temp(), runtime: "/rt" }, "darwin", () => {}, exec);
    expect(await managed.offer("@openai/codex", bareLaunch("npm"), undefined, "arm64")).toEqual({ package: "@openai/codex", version: "0.163.0", bytes: 340807156 });
    expect(asked[1].slice(0, 3)).toEqual(["view", "@openai/codex@0.163.0-darwin-arm64", "dist.unpackedSize"]);
  });

  it("finds the native package by platform and architecture", () => {
    expect(nativeSpec({ "@x/cli-win32-x64": "1.0.0", "@x/cli-windows-arm64": "1.0.0" }, "win32", "arm64")).toBe("@x/cli-windows-arm64@1.0.0");
    expect(nativeSpec({ "@x/cli-linux-x64-musl": "1.0.0", "@x/cli-linux-x64": "1.0.0" }, "linux", "x64")).toBe("@x/cli-linux-x64@1.0.0");
    expect(nativeSpec({}, "darwin", "arm64")).toBeNull();
  });
});

describe("the bin a managed copy runs", () => {
  it("picks the bin the engine's command names, as an absolute file", () => {
    const prefix = temp();
    const root = installed(prefix, "@tencent-ai/codebuddy-code", { cbc: "./bin/codebuddy", codebuddy: "./bin/codebuddy" }, { "bin/codebuddy": "#!/usr/bin/env node\n" });
    expect(managedBin(prefix, "@tencent-ai/codebuddy-code", "codebuddy")).toEqual({ file: path.join(root, "bin", "codebuddy"), kind: "node" });
  });

  it("uses Claude Code's own Node entry when its bin is still the placeholder, and reports a placeholder otherwise", () => {
    const prefix = temp();
    const stub = 'echo "Error: claude native binary not installed."\n';
    const root = installed(prefix, "@anthropic-ai/claude-code", { claude: "bin/claude.exe" }, { "bin/claude.exe": stub, "cli-wrapper.cjs": "require('x')\n" });
    expect(managedBin(prefix, "@anthropic-ai/claude-code", "claude")).toEqual({ file: path.join(root, "cli-wrapper.cjs"), kind: "node" });
    const other = temp();
    installed(other, "opencode-ai", { opencode: "bin/opencode" }, { "bin/opencode": stub });
    expect(managedBin(other, "opencode-ai", "opencode")?.kind).toBe("stub");
  });
});

describe("switching to a new version", () => {
  const PKG = "@x/cli";
  const setup = () => {
    const dir = temp();
    const pointed: (ManagedCli | null)[] = [];
    const managed = new ManagedCopies({ dir, runtime: "/rt" }, process.platform, (_cli, copy) => void pointed.push(copy));
    const install = (version: string) => installed(managed.prefix("x", version), PKG, { x: "cli.js" }, { "cli.js": `console.log("${version}")` });
    const has = (version: string) => fs.existsSync(managed.prefix("x", version));
    return { managed, pointed, install, has, last: () => pointed.at(-1) };
  };

  it("keeps a new version only once its test passes, and the one before it", () => {
    const { managed, install, has, last } = setup();
    install("1.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "1.0.0", prefer: true });
    // On trial it goes first, so the test reaches it.
    expect(last()).toMatchObject({ version: "1.0.0", prefer: true });
    expect(managed.settle("x", true)).toEqual({ cli: "x", package: PKG, current: "1.0.0", prefer: true });

    install("2.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "2.0.0", prefer: true });
    expect(managed.stateOf("x")).toMatchObject({ current: "1.0.0", trial: "2.0.0" });
    expect(managed.settle("x", true)).toEqual({ cli: "x", package: PKG, current: "2.0.0", previous: "1.0.0", prefer: true });
    expect(last()).toMatchObject({ version: "2.0.0" });

    install("3.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "3.0.0", prefer: true });
    managed.settle("x", true);
    // Two kept: the one in use and the one before it.
    expect([has("1.0.0"), has("2.0.0"), has("3.0.0")]).toEqual([false, true, true]);
  });

  it("goes back to the version in use when the new one fails its test, and removes the new one", () => {
    const { managed, install, has, last } = setup();
    install("1.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "1.0.0", prefer: false });
    managed.settle("x", true);
    install("2.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "2.0.0", prefer: false });
    expect(last()).toMatchObject({ version: "2.0.0", prefer: true });
    expect(managed.settle("x", false)).toEqual({ cli: "x", package: PKG, current: "1.0.0", prefer: false });
    expect(last()).toMatchObject({ version: "1.0.0", prefer: false });
    expect(has("2.0.0")).toBe(false);
  });

  it("with none in use yet, a failed trial stays behind the person's own copy for a later test", () => {
    const { managed, install, last } = setup();
    install("1.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "1.0.0", prefer: true });
    expect(managed.settle("x", false)).toMatchObject({ trial: "1.0.0", failed: true, prefer: false });
    expect(last()).toMatchObject({ version: "1.0.0", prefer: false });
    // Signed in since, its test passes: now it is kept.
    expect(managed.settle("x", true)).toMatchObject({ current: "1.0.0" });
  });

  it("points every locator at its copy again on the next start, the state file being the truth", () => {
    const { managed, install } = setup();
    install("1.0.0");
    managed.begin("x", { cli: "x", package: PKG, version: "1.0.0", prefer: true });
    managed.settle("x", true);
    const seen: [string, ManagedCli | null][] = [];
    new ManagedCopies(managed.config, process.platform, (cli, copy) => void seen.push([cli, copy])).start();
    expect(seen).toEqual([["x", expect.objectContaining({ version: "1.0.0", prefer: true, runtime: "/rt" })]]);
  });

  it("checks an installed version runs, and names a placeholder bin", async () => {
    const dir = temp();
    const runs: CliLaunch[] = [];
    const managed = new ManagedCopies({ dir, runtime: process.execPath }, process.platform, () => {}, undefined, async (launch) => {
      runs.push(launch);
      return { code: 0, stdout: "x 1.0.0\n", stderr: "" };
    });
    installed(managed.prefix("x", "1.0.0"), PKG, { x: "cli.js" }, { "cli.js": "" });
    expect(await managed.check("x", { cli: "x", package: PKG }, "1.0.0")).toEqual({ ready: true, version: "1.0.0" });
    expect(runs[0].argv(["--version"]).command).toBe(process.execPath);
    installed(managed.prefix("x", "2.0.0"), PKG, { x: "bin/x" }, { "bin/x": "echo not installed\n" });
    expect(await managed.check("x", { cli: "x", package: PKG }, "2.0.0")).toMatchObject({ ready: false, kind: "native-missing" });
  });
});
