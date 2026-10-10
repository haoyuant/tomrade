import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { readManifest } from "@tomradex/plugin-kit";
import { SHARED } from "./sandbox.js";

export interface BuildResult {
  ok: boolean;
  outfile: string;
  errors: string[];
  warnings: string[];
  /** Third-party packages bundled in, as `name@version` where it can be told. */
  bundled: string[];
}

const ENTRIES = ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.mjs", "index.ts", "index.js"];
const SCENARIOS = ["src/test.ts", "src/test.js", "tests/scenario.ts", "tests/scenario.js"];

export const entryOf = (dir: string): string | null => ENTRIES.map((e) => path.join(dir, e)).find((f) => fs.existsSync(f)) ?? null;
export const scenarioOf = (dir: string): string | null => SCENARIOS.map((e) => path.join(dir, e)).find((f) => fs.existsSync(f)) ?? null;

/** What a plugin shares with the host instead of carrying its own copy. */
const external = [...SHARED, "zod/*"];

const format = (m: esbuild.Message) => `${m.location ? `${m.location.file}:${m.location.line}:${m.location.column} ` : ""}${m.text}`;

/**
 * One readable ESM file per plugin: every dependency bundled in except the
 * few the host provides, nothing minified, so the review reads what runs.
 * Documents and images under `static/` are copied beside it. Bundling runs no
 * plugin code; nothing here executes what it builds.
 */
export async function build(dir: string): Promise<BuildResult> {
  const manifest = readManifest(dir);
  const entry = entryOf(dir);
  const outfile = path.join(dir, manifest.main);
  if (!entry) return { ok: false, outfile, errors: [`no entry point: expected one of ${ENTRIES.join(", ")}`], warnings: [], bundled: [] };
  const common: esbuild.BuildOptions = {
    absWorkingDir: dir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external,
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    logLevel: "silent",
    metafile: true,
    write: true
  };
  try {
    const result = await esbuild.build({ ...common, entryPoints: [entry], outfile });
    const scenario = scenarioOf(dir);
    if (scenario) await esbuild.build({ ...common, entryPoints: [scenario], outfile: path.join(path.dirname(outfile), "test.js") });
    const staticDir = path.join(dir, "static");
    if (fs.existsSync(staticDir)) fs.cpSync(staticDir, path.join(path.dirname(outfile), "static"), { recursive: true });
    const bundled = [
      ...new Set(
        Object.keys(result.metafile?.inputs ?? {}).flatMap((input) => {
          const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, "/").split("node_modules/.pnpm/").pop() ?? input);
          return m ? [m[1]!] : [];
        })
      )
    ].sort();
    return { ok: true, outfile, errors: [], warnings: result.warnings.map(format), bundled };
  } catch (error) {
    const failure = error as esbuild.BuildFailure;
    return { ok: false, outfile, errors: failure.errors?.map(format) ?? [String(error)], warnings: failure.warnings?.map(format) ?? [], bundled: [] };
  }
}

/** Rebuild on every change; `onBuild` sees each result. Returns a stop function. */
export async function watch(dir: string, onBuild: (result: BuildResult) => void): Promise<() => Promise<void>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void build(dir).then(onBuild), 150);
  };
  run();
  const watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
    const rel = String(file ?? "");
    if (rel.startsWith("dist") || rel.startsWith("node_modules") || rel.startsWith(".git")) return;
    run();
  });
  return async () => {
    clearTimeout(timer);
    watcher.close();
  };
}
