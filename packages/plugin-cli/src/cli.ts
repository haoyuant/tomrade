#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { build, watch } from "./build.js";
import { check, pack, test, type CheckReport } from "./check.js";
import { release } from "./release.js";
import { scaffold } from "./scaffold.js";

const [command = "help", ...rest] = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]!;
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=", 2);
    const next = rest[i + 1];
    if (value !== undefined) flags.set(key!, value);
    else if (next && !next.startsWith("--")) flags.set(key!, (i++, next));
    else flags.set(key!, true);
  } else positional.push(arg);
}
const dir = path.resolve(positional[0] ?? ".");
const flag = (name: string) => (typeof flags.get(name) === "string" ? (flags.get(name) as string) : undefined);

function printCheck(report: CheckReport) {
  if (flags.has("json")) return console.log(JSON.stringify(report, null, 2));
  const m = report.manifest;
  if (m) console.log(`${m.id} ${m.version} — ${report.verdict}${report.risk ? ` · risk ${report.risk.level}` : ""}`);
  for (const p of report.problems) console.log(`  ✗ ${p}`);
  for (const f of report.analysis?.findings ?? []) console.log(`  ${f.severity === "info" ? "·" : "!"} [${f.severity}] ${f.message} (${f.file}:${f.line})`);
  for (const n of report.notes) console.log(`  · ${n}`);
  for (const im of report.imAdapters) console.log(`  IM adapter ${im.id}: contract ${im.contract}${im.capabilities.length ? ` (${im.capabilities.join(", ")})` : ""}`);
  if (report.official.length) console.log("  official standard (STANDARDS.md in tomrade-plugins):");
  for (const p of report.official) console.log(`    ✗ ${p}`);
  if (report.publishing.length) console.log("  before publishing:");
  for (const p of report.publishing) console.log(`    - ${p}`);
  const c = report.manifest?.contributes;
  if (c) console.log(`  contributes: ${Object.entries(c).filter(([, v]) => v?.length).map(([k, v]) => `${k} ${v!.join(", ")}`).join("; ") || "nothing"}`);
}

const usage = `tomrade-plugin <command> [dir]

  init [dir] --id publisher/name [--title T] [--description D]   start a plugin
  build [dir]      bundle src/ into dist/ (one readable file; cordis, the SDK and zod come from Tomrade)
  dev [dir]        rebuild on every change — load the folder in Tomrade and it reloads itself
  check [dir]      build, inspect in a sandbox, and read the code: what someone installing it will see
                   [--official] also hold it to the standard of Tomrade's own plugins
  test [dir]       run the plugin against a throwaway project in a sandbox (src/test.ts is the scenario)
  pack [dir]       check, then write a .tomrade-plugin file [--out file]
  release [dir] --out dir --commit sha [--catalog catalog.json] [--revoked revoked.json]
                   one of Tomrade's own: check --official, sign (TOMRADE_SIGNING_KEY, PKCS#8 PEM), pack,
                   and write the catalog with this version added
`;

async function main(): Promise<number> {
  switch (command) {
    case "init": {
      const id = flag("id");
      if (!id) throw new Error("init needs --id publisher/name");
      const written = scaffold(dir, { id, title: flag("title"), description: flag("description"), author: flag("author") });
      console.log(`wrote ${written.length} files in ${dir}\nnext: npm install && npm run dev`);
      return 0;
    }
    case "build": {
      const result = await build(dir);
      for (const w of result.warnings) console.warn(`warning: ${w}`);
      for (const e of result.errors) console.error(`error: ${e}`);
      if (result.ok) console.log(`built ${path.relative(process.cwd(), result.outfile)}${result.bundled.length ? ` (bundled ${result.bundled.join(", ")})` : ""}`);
      return result.ok ? 0 : 1;
    }
    case "dev": {
      await watch(dir, (result) => console.log(result.ok ? `rebuilt ${new Date().toLocaleTimeString()}` : `build failed:\n  ${result.errors.join("\n  ")}`));
      console.log(`watching ${dir} — in Tomrade: Settings → Plugins → Load folder, once`);
      await new Promise(() => {});
      return 0;
    }
    case "check": {
      const report = await check(dir, { official: flags.has("official") });
      printCheck(report);
      return report.verdict === "blocked" ? 1 : 0;
    }
    case "test": {
      const result = await test(dir);
      if (result.error) console.error(`error: ${result.error}`);
      for (const c of result.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      for (const l of result.logs) console.log(`  ${l}`);
      return result.ok ? 0 : 1;
    }
    case "pack": {
      const { report, file } = await pack(dir, { out: flag("out") });
      printCheck(report);
      if (file) console.log(`wrote ${file}`);
      return file ? 0 : 1;
    }
    case "release": {
      const privateKey = process.env.TOMRADE_SIGNING_KEY ?? (process.env.TOMRADE_SIGNING_KEY_FILE ? fs.readFileSync(process.env.TOMRADE_SIGNING_KEY_FILE, "utf8") : undefined);
      if (!privateKey) throw new Error("Set TOMRADE_SIGNING_KEY (PKCS#8 PEM) or TOMRADE_SIGNING_KEY_FILE");
      const out = flag("out");
      const commit = flag("commit");
      if (!out || !commit) throw new Error("release needs --out dir and --commit sha");
      const result = await release(dir, { privateKey, out: path.resolve(out), commit, catalog: flag("catalog"), revoked: flag("revoked") });
      printCheck(result.report);
      if (!result.catalog) return 1;
      console.log(result.unchanged ? `${result.report.manifest!.id} ${result.report.manifest!.version} was released already; catalog rewritten` : `wrote ${result.file}`);
      console.log(`wrote ${result.catalog}`);
      return 0;
    }
    default:
      console.log(usage);
      return command === "help" ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
