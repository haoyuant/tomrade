import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { analyzePackage, atLeast, packPlugin, readManifest, type Analysis } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, isOpenSource, riskOf, satisfies, type Manifest, type Risk } from "@tomradex/plugin-sdk";
import { build, scenarioOf, type BuildResult } from "./build.js";
import { runSandboxed, type InspectResult, type SandboxOptions, type TestResult } from "./sandbox.js";
import type { Recording } from "./record.js";

export interface CheckReport {
  manifest: Manifest | null;
  problems: string[];
  /** What stands between this plugin and the store, beyond the problems. */
  publishing: string[];
  /** Worth knowing, never blocking. */
  notes: string[];
  /** The IM contract each adapter declares. */
  imAdapters: Recording["imContracts"];
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
    for (const key of ["tools", "commands", "badges", "statusItems", "sections", "graphs", "sidebarModules", "playbooks", "settings", "surfaces", "tables", "imAdapters"] as const) if (rec[key].length) contributes[key] = [...new Set(rec[key])].sort();
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

/**
 * Everything a person or the agent should know before a build loads: the
 * manifest is valid, the code builds, its registrations carry the namespace,
 * and what it does matches what it says. The same check runs on the store's
 * side before a plugin is listed.
 */
export async function check(dir: string, opts: SandboxOptions & { build?: boolean } = {}): Promise<CheckReport> {
  const report: CheckReport = { manifest: null, problems: [], publishing: [], notes: [], imAdapters: [], build: null, inspection: null, analysis: null, risk: null, verdict: "blocked" };
  try {
    report.manifest = readManifest(dir);
  } catch (error) {
    report.problems.push(...(error instanceof ZodError ? describeZod(error) : [error instanceof Error ? error.message : String(error)]));
    return report;
  }
  if (opts.build !== false) {
    report.build = await build(dir);
    if (!report.build.ok) {
      report.problems.push(...report.build.errors);
      return report;
    }
  }
  report.inspection = await runSandboxed("inspect", dir, opts);
  if (!report.inspection.ok) {
    report.problems.push(report.inspection.error ?? "the plugin could not be inspected");
    return report;
  }
  stamp(dir, report.inspection);
  report.manifest = readManifest(dir);
  const rec = report.inspection.recording!;
  for (const v of rec.violations) report.problems.push(`${v.kind} "${v.id}" must start with the namespace`);
  if (rec.stopped) report.problems.push(`apply() stopped when inspected: ${rec.stopped}`);
  report.imAdapters = rec.imContracts ?? [];
  for (const im of report.imAdapters) {
    if (im.invalid) report.problems.push(`IM adapter "${im.id}" declares invalid capabilities: ${im.invalid}`);
    // An older host ignores these fields, so the adapter still loads there, only without them.
    else if (im.contract === "0.2.5" && satisfies("0.2.4", report.manifest.engines.sdk))
      report.notes.push(`IM adapter "${im.id}" declares ${im.capabilities.join(", ")} (SDK 0.2.5); with engines.sdk "${report.manifest.engines.sdk}" a Tomrade older than 0.2.5 loads it without them — use "^0.2.5" to require them`);
  }
  report.analysis = analyzePackage(dir, report.manifest);
  report.risk = riskOf(report.manifest);
  report.publishing = publishingProblems(dir, report.manifest);
  const critical = atLeast(report.analysis.worst, "critical");
  report.verdict = report.problems.length || critical ? "blocked" : atLeast(report.analysis.worst, "high") || report.risk.level === "high" ? "review" : "ok";
  return report;
}

export async function test(dir: string, opts: SandboxOptions & { build?: boolean } = {}): Promise<TestResult> {
  if (opts.build !== false) {
    const built = await build(dir);
    if (!built.ok) return { ok: false, error: built.errors.join("\n"), checks: [], logs: [] };
  }
  const scenario = scenarioOf(dir) ? path.join(path.dirname(readManifest(dir).main), "test.js") : undefined;
  return runSandboxed("test", dir, { ...opts, scenario });
}

export async function pack(dir: string, opts: SandboxOptions & { out?: string } = {}) {
  const report = await check(dir, opts);
  if (report.verdict === "blocked") return { report, file: null };
  const { file, digest } = await packPlugin(dir, opts.out);
  return { report, file, digest };
}
