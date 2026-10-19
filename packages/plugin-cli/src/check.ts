import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { analyzePackage, atLeast, packPlugin, readLanguagePack, readManifest, type Analysis } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, isOpenSource, languageCoverage, riskOf, satisfies, type Dictionaries, type LanguageCoverage, type LanguagePack, type Manifest, type Risk } from "@tomradex/plugin-sdk";
import { build, scenarioOf, type BuildResult } from "./build.js";
import { officialProblems } from "./official.js";
import { runSandboxed, type InspectResult, type SandboxOptions, type TestResult } from "./sandbox.js";
import { sdkImportProblems } from "./sdk-imports.js";
import type { Recording } from "./record.js";

export interface CheckReport {
  manifest: Manifest | null;
  problems: string[];
  /** What stands between this plugin and the store, beyond the problems. */
  publishing: string[];
  /** Worth knowing, never blocking. */
  notes: string[];
  /** With `official`: where the plugin falls short of Tomrade's own standard; any of these blocks. */
  official: string[];
  /** The IM contract each adapter declares. */
  imAdapters: Recording["imContracts"];
  /** Each language the plugin adds, and how much of English it covers where English was at hand. */
  languages: { tag: string; name: string; ui: LanguageCoverage | null; backend: LanguageCoverage | null }[];
  build: BuildResult | null;
  inspection: InspectResult | null;
  analysis: Analysis | null;
  risk: Risk | null;
  /** `blocked`: fix before loading or publishing. `review`: loads, but a person should read the findings. */
  verdict: "ok" | "review" | "blocked";
}

const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/;

const describeZod = (error: ZodError) => error.issues.map((i) => `${MANIFEST_FILE} ${i.path.join(".") || "(root)"}: ${i.message}`);

/** Writes what the plugin was seen to need and register back into its manifest; the author's own fields stay as written. */
export function stamp(dir: string, inspection: InspectResult): void {
  const file = path.join(dir, MANIFEST_FILE);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const rec = inspection.recording;
  raw.inject = inspection.inject;
  raw.optional = inspection.optional;
  if (rec) {
    const contributes: Record<string, string[]> = {};
    for (const key of ["tools", "commands", "badges", "statusItems", "sections", "graphs", "sidebarModules", "playbooks", "settings", "surfaces", "tables", "imAdapters", "webSearchProviders", "agentHooks", "modelProviders"] as const) if (rec[key].length) contributes[key] = [...new Set(rec[key])].sort();
    raw.contributes = contributes;
  }
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

export function publishingProblems(dir: string, manifest: Manifest): string[] {
  const out: string[] = [];
  if (!isOpenSource(manifest.license)) out.push(`the license "${manifest.license}" is not an OSI-approved SPDX identifier; the store takes open-source plugins only`);
  if (!manifest.repository || !GITHUB.test(manifest.repository)) out.push("repository must be the plugin's public GitHub repository (https://github.com/owner/name)");
  if (!fs.readdirSync(dir).some((f) => /^LICEN[CS]E/i.test(f))) out.push("a LICENSE file must ship with the source");
  if (!fs.readdirSync(dir).some((f) => /^README/i.test(f))) out.push("a README must say what the plugin does");
  if (!manifest.description) out.push("description is empty; the store shows it beside the title");
  return out;
}

/** The English a language pack translates, as the running Tomrade holds it; a side left out is not measured. */
export interface EnglishWords {
  ui?: Dictionaries | null;
  backend?: Dictionaries | null;
}

const sample = (keys: string[], n = 12) => `${keys.slice(0, n).join(", ")}${keys.length > n ? ` and ${keys.length - n} more` : ""}`;

/** Each language reads as the format says; with English at hand, how much of it the pack covers. A gap reads English, so none of it blocks. */
function checkLanguages(dir: string, report: CheckReport, english: EnglishWords | undefined): void {
  for (const entry of report.manifest!.languages) {
    let pack: LanguagePack;
    try {
      pack = readLanguagePack(dir, entry);
    } catch (error) {
      report.problems.push(`language "${entry.tag}": ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const ui = english?.ui ? languageCoverage(english.ui, pack.ui) : null;
    const backend = english?.backend ? languageCoverage(english.backend, pack.backend) : null;
    report.languages.push({ tag: pack.tag, name: pack.name, ui, backend });
    for (const [side, coverage] of [["interface", ui], ["backend", backend]] as const) {
      if (!coverage) {
        report.notes.push(`language "${pack.tag}": its ${side} coverage is measured against a running Tomrade's English (plugin_check in Plugin Studio)${side === "interface" && english?.backend ? " once its window has opened" : ""}`);
        continue;
      }
      report.notes.push(`language "${pack.tag}": ${coverage.translated} of ${coverage.total} ${side} strings translated; the rest read English`);
      if (coverage.missing.length) report.notes.push(`language "${pack.tag}": ${side} strings it does not translate: ${sample(coverage.missing)}`);
      if (coverage.stale.length) report.notes.push(`language "${pack.tag}": ${side} keys English no longer has, which nothing reads: ${sample(coverage.stale)}`);
      for (const m of coverage.slotMismatches.slice(0, 12))
        report.notes.push(`language "${pack.tag}": ${side} ${m.key} asks for ${m.translated.join(" ") || "no values"} where English asks for ${m.english.join(" ") || "none"}; it reads English until they match`);
      if (coverage.slotMismatches.length > 12) report.notes.push(`language "${pack.tag}": ${coverage.slotMismatches.length - 12} more ${side} strings whose values differ from English`);
    }
  }
}

/**
 * Everything a person or the agent should know before a build loads: the
 * manifest is valid, the code builds, its registrations carry the namespace,
 * and what it does matches what it says. The same check runs on the store's
 * side before a plugin is listed.
 */
export async function check(dir: string, opts: SandboxOptions & { build?: boolean; official?: boolean; english?: EnglishWords } = {}): Promise<CheckReport> {
  const report: CheckReport = { manifest: null, problems: [], publishing: [], notes: [], official: [], imAdapters: [], languages: [], build: null, inspection: null, analysis: null, risk: null, verdict: "blocked" };
  try {
    report.manifest = readManifest(dir);
  } catch (error) {
    report.problems.push(...(error instanceof ZodError ? describeZod(error) : [error instanceof Error ? error.message : String(error)]));
    return report;
  }
  // A plugin that is data only (main: null) has no code to build or inspect.
  if (report.manifest.main !== null) {
    if (opts.build !== false) {
      report.build = await build(dir);
      if (!report.build.ok) {
        report.problems.push(...report.build.errors);
        return report;
      }
    }
    const imports = sdkImportProblems(path.join(dir, report.manifest.main), report.manifest.engines.sdk);
    report.problems.push(...imports.problems);
    report.notes.push(...imports.notes);
    report.inspection = await runSandboxed("inspect", dir, opts);
    if (!report.inspection.ok) {
      report.problems.push(report.inspection.error ?? "the plugin could not be inspected");
      return report;
    }
    if (report.inspection.full) {
      report.notes.push("full mode: the plugin gets Tomrade's whole context, so the sandbox only checks its shape — try it in Tomrade (plugin_try); its rows apply when Tomrade starts again");
    } else {
      stamp(dir, report.inspection);
      report.manifest = readManifest(dir);
      const rec = report.inspection.recording!;
      for (const v of rec.violations) report.problems.push(`${v.kind} "${v.id}" must start with the namespace`);
      report.problems.push(...rec.invalid);
      // An older Tomrade does not know the service and refuses the plugin as it installs.
      if (rec.modelProviders.length && satisfies("0.2.15", report.manifest.engines.sdk)) report.problems.push(`model providers need SDK 0.2.16; with engines.sdk "${report.manifest.engines.sdk}" an older Tomrade cannot load the plugin — use "^0.2.16"`);
      if (rec.stopped) report.problems.push(`apply() stopped when inspected: ${rec.stopped}`);
      report.imAdapters = rec.imContracts ?? [];
      for (const im of report.imAdapters) {
        if (im.invalid) report.problems.push(`IM adapter "${im.id}" declares invalid capabilities: ${im.invalid}`);
        // An older host ignores these fields, so the adapter still loads there, only without them.
        else if (im.contract === "0.2.5" && satisfies("0.2.4", report.manifest.engines.sdk))
          report.notes.push(`IM adapter "${im.id}" declares ${im.capabilities.join(", ")} (SDK 0.2.5); with engines.sdk "${report.manifest.engines.sdk}" a Tomrade older than 0.2.5 loads it without them — use "^0.2.5" to require them`);
      }
    }
  }
  checkLanguages(dir, report, opts.english);
  report.analysis = analyzePackage(dir, report.manifest);
  report.risk = riskOf(report.manifest);
  report.publishing = publishingProblems(dir, report.manifest);
  if (opts.official) {
    report.official = officialProblems(dir, report.manifest);
    if (scenarioOf(dir) && report.manifest.context !== "full") {
      const scenario = await test(dir, { ...opts, build: false });
      if (scenario.error) report.official.push(`src/test.ts did not run: ${scenario.error}`);
      for (const c of scenario.checks.filter((c) => !c.ok)) report.official.push(`src/test.ts: "${c.name}" failed${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }
  const critical = atLeast(report.analysis.worst, "critical");
  report.verdict = report.problems.length || report.official.length || critical ? "blocked" : atLeast(report.analysis.worst, "high") || report.risk.level === "high" ? "review" : "ok";
  return report;
}

export async function test(dir: string, opts: SandboxOptions & { build?: boolean } = {}): Promise<TestResult> {
  if (opts.build !== false) {
    const built = await build(dir);
    if (!built.ok) return { ok: false, error: built.errors.join("\n"), checks: [], logs: [] };
  }
  const main = readManifest(dir).main;
  const scenario = main !== null && scenarioOf(dir) ? path.join(path.dirname(main), "test.js") : undefined;
  return runSandboxed("test", dir, { ...opts, scenario });
}

export async function pack(dir: string, opts: SandboxOptions & { out?: string } = {}) {
  const report = await check(dir, opts);
  if (report.verdict === "blocked") return { report, file: null };
  const { file, digest } = await packPlugin(dir, opts.out);
  return { report, file, digest };
}
