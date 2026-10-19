import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "@tomradex/plugin-kit";
import { namespaceOf } from "@tomradex/plugin-sdk";
import type { Recording } from "./record.js";

export const RESULT_MARK = "@@tomrade-sandbox@@";

/** Imports a plugin needs from the host and must not bundle. */
export const SHARED = ["cordis", "@tomradex/plugin-sdk", "zod", "zod/v4", "zod/v4/core", "zod/mini"];

export interface InspectResult {
  ok: boolean;
  error?: string;
  inject: string[];
  optional: string[];
  recording: Recording | null;
}

export interface TestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  checks: TestCheck[];
  logs: string[];
}

export interface SandboxOptions {
  /** Node, or Electron run as Node. Defaults to the running binary. */
  execPath?: string;
  timeoutMs?: number;
  /** A scenario module shipped with the plugin, run in test mode. */
  scenario?: string;
}

/** Where the child lives: beside this file once built, in dist/ when this file runs from source. */
const childFile = (): string => {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts") ? path.join(path.dirname(here), "..", "dist", "child.js") : path.join(path.dirname(here), "child.js");
};

/**
 * The app's runtime root: the nearest directory above this package holding a
 * pnpm store, or failing that the outermost one with node_modules. The child
 * may read under it and nowhere else but the plugin's folder.
 */
function hostRoot(): string {
  let dir = path.dirname(fs.realpathSync(childFile()));
  let outermost: string | null = null;
  while (true) {
    if (fs.existsSync(path.join(dir, "node_modules", ".pnpm"))) return dir;
    if (fs.existsSync(path.join(dir, "node_modules"))) outermost = dir;
    const up = path.dirname(dir);
    if (up === dir || dir === os.homedir()) return outermost ?? path.dirname(childFile());
    dir = up;
  }
}

/**
 * Runs a plugin's code where it cannot write to disk, start programs or read
 * outside its own folder and the host's runtime — the only place agent-written
 * code runs before a person confirms it. The network is not closed by the
 * Node this app embeds, and the report says so.
 */
export async function runSandboxed(mode: "inspect", dir: string, opts?: SandboxOptions): Promise<InspectResult>;
export async function runSandboxed(mode: "test", dir: string, opts?: SandboxOptions): Promise<TestResult>;
export async function runSandboxed(mode: "inspect" | "test", dir: string, opts: SandboxOptions = {}): Promise<InspectResult | TestResult> {
  const pluginDir = fs.realpathSync(dir);
  const manifest = readManifest(pluginDir);
  if (manifest.main === null) {
    const error = "the plugin has no code to run (main is null)";
    return mode === "inspect" ? { ok: false, error, inject: [], optional: [], recording: null } : { ok: false, error, checks: [], logs: [] };
  }
  const child = childFile();
  if (!fs.existsSync(child)) throw new Error(`${child} is missing; build @tomradex/plugin-cli first`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sandbox-")));
  const reads = [...new Set([pluginDir, tmp, hostRoot()])];
  const payload = {
    mode,
    dir: pluginDir,
    main: path.join(pluginDir, manifest.main),
    id: manifest.id,
    namespace: namespaceOf(manifest),
    title: manifest.title,
    window: manifest.permissions.window,
    tmp,
    scenario: opts.scenario ? path.join(pluginDir, opts.scenario) : null
  };
  const args = [
    "--permission",
    ...reads.map((r) => `--allow-fs-read=${r}`),
    `--allow-fs-write=${tmp}`,
    // The host's SQLite is a native addon; test mode boots it in memory.
    ...(mode === "test" ? ["--allow-addons"] : []),
    "--no-warnings",
    child,
    JSON.stringify(payload)
  ];
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(opts.execPath ?? process.execPath, args, { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`the plugin did not finish within ${opts.timeoutMs ?? 30_000} ms`));
      }, opts.timeoutMs ?? 30_000);
      proc.on("error", reject);
      proc.on("close", () => {
        clearTimeout(timer);
        const line = stdout.split("\n").find((l) => l.startsWith(RESULT_MARK));
        if (line) resolve(line.slice(RESULT_MARK.length));
        else reject(new Error(stderr.trim().split("\n").slice(-5).join("\n") || "the sandbox exited without a result"));
      });
    });
    return JSON.parse(output) as InspectResult | TestResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return mode === "inspect" ? { ok: false, error: message, inject: [], optional: [], recording: null } : { ok: false, error: message, checks: [], logs: [] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
