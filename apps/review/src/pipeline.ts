import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { check, publishingProblems, test, type CheckReport, type TestResult } from "@tomradex/plugin-cli";
import { ATTESTATION_FILE, atLeast, attest, packPlugin, readManifest, writeAttestation, type Analysis, type Attestation, type Observed, type ReviewReport } from "@tomradex/plugin-kit";
import { expansion } from "@tomradex/community";
import { riskOf, type Manifest, type RiskLevel } from "@tomradex/plugin-sdk";
import type { Judge, JudgeResult, Verdict } from "./judge.js";

const run = promisify(execFile);

export interface Submission {
  id: string;
  plugin_id: string;
  version: string;
  repository: string;
  commit_sha: string;
  tag: string | null;
}

export interface PreviousVersion {
  version: string;
  tier: "ai-reviewed" | "reviewed" | "official" | null;
  reviewed_as: string | null;
  commit_sha: string;
  manifest: Manifest | null;
}

export interface Outcome {
  status: "listed" | "held" | "rejected";
  tier: "ai-reviewed" | "reviewed" | null;
  risk: RiskLevel;
  riskReasons: string[];
  report: ReviewReport;
  manifest: Manifest | null;
  digest: string | null;
  attestation: Attestation | null;
  packagePath: string | null;
  packageSize: number | null;
  reviewedAs: string | null;
}

export interface Registry {
  previousListed(pluginId: string, before: string): Promise<PreviousVersion | null>;
  progress(submission: Submission, status: "building" | "reviewing"): Promise<void>;
  upload(objectPath: string, bytes: Buffer): Promise<void>;
  finish(submission: Submission, outcome: Outcome): Promise<void>;
  fail(submission: Submission, error: string): Promise<void>;
}

/** Puts the repository's tree at `commit` into `dest`. */
export type SourceFetcher = (repository: string, commit: string, dest: string) => Promise<void>;

export interface PipelineDeps {
  registry: Registry;
  fetchSource: SourceFetcher;
  judge: Judge;
  /** PKCS#8 PEM of the store's Ed25519 key. */
  signingKey: string;
  workDir: string;
  /** Node, or Electron run as Node, for the sandbox. */
  execPath?: string;
  /** Installs production dependencies without running their scripts. */
  installDependencies?: (dir: string) => Promise<void>;
}

const RANK: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };
const higher = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b);

/** Risk from what the code was seen doing, beside what the manifest declares. */
export function observedRisk(observed: Observed, manifest: Manifest): { level: RiskLevel; reasons: string[] } {
  const declared = riskOf(manifest);
  const reasons = new Set(declared.reasons);
  let level = declared.level;
  const add = (reason: string, at: RiskLevel) => {
    reasons.add(reason);
    level = higher(level, at);
  };
  if (observed.exec) add("exec", "high");
  if (observed.rawDatabase) add("raw-database", "high");
  if (observed.coreTableWrites.length) add("core-table-writes", "high");
  if (observed.dynamicCode) add("dynamic-code", "high");
  if (observed.network && !manifest.permissions.network.length) add("network", "elevated");
  if (observed.fs && manifest.permissions.fs === "none") add("fs", "elevated");
  if (observed.env) add("env", "elevated");
  return { level, reasons: [...reasons] };
}

export interface Decision {
  status: Outcome["status"];
  why: string;
}

/**
 * The store's rules. Only clearly malicious code is refused; high risk is
 * labelled and listed. What the model cannot clear — a suspicion, a critical
 * static finding, a refusal, a submission too large to read — waits for a
 * person rather than being listed or refused on a guess.
 */
export function decide(judged: JudgeResult, analysis: Analysis): Decision {
  const v = judged.verdict;
  if (v && v.malicious.verdict === "clear" && v.malicious.confidence !== "low") return { status: "rejected", why: "the review found clearly malicious code" };
  if (judged.refused) return { status: "held", why: `the review model declined (${judged.refused}); a person will review it` };
  if (judged.tooLarge) return { status: "held", why: "too large for the automatic review to read whole; a person will review it" };
  if (!v) return { status: "held", why: "the review produced no verdict" };
  if (v.malicious.verdict !== "none") return { status: "held", why: "the review suspects harmful behaviour; a person will review it" };
  if (atLeast(analysis.worst, "critical")) return { status: "held", why: "static analysis found marks of malice the review did not explain away; a person will review it" };
  if (v.promptInjection.length) return { status: "held", why: "text in the plugin tries to steer an AI; a person will review it" };
  return { status: "listed", why: v.matchesDescription ? "reviewed" : "reviewed; it does more than its description says" };
}

/** Whether a human review of an earlier version still stands for this one. */
export function carryOver(previous: PreviousVersion | null, judged: JudgeResult, expands: string[]): string | null {
  if (!previous || (previous.tier !== "reviewed" && previous.tier !== "official")) return null;
  const d = judged.verdict?.diff;
  if (!d || !d.carryOver || d.risk !== "low" || expands.length) return null;
  return previous.reviewed_as ?? previous.version;
}

const SKIP = new Set(["node_modules", ".git", "dist"]);
const TEXT = /\.(m?[jt]sx?|cjs|json|md|html?|css|txt|ya?ml|toml|sql)$|^(README|LICEN[CS]E|NOTICE|CHANGELOG)/i;

/** The plugin's own files, as the model reads them: everything but dependencies, builds and lockfiles. */
export function sourceFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile() && TEXT.test(e.name) && !/lock(\.json|\.ya?ml)?$|-lock\.json$/.test(e.name)) out[r] = fs.readFileSync(path.join(abs, e.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

async function sourceDiff(before: string, after: string): Promise<string> {
  try {
    await run("git", ["diff", "--no-index", "--no-color", "--", before, after], { maxBuffer: 32 * 1024 * 1024 });
    return "";
  } catch (error) {
    // git diff exits 1 when the trees differ; the patch is on stdout.
    const out = (error as { stdout?: string }).stdout ?? "";
    return out
      .split(/^(?=diff --git )/m)
      .filter((chunk) => !/\/(node_modules|dist|\.git)\//.test(chunk.split("\n")[0] ?? ""))
      .join("")
      .replaceAll(before, "a")
      .replaceAll(after, "b");
  }
}

const emptyReport = (why: string, extra: Partial<ReviewReport> = {}): ReviewReport => ({
  v: 1,
  verdict: "rejected",
  summary: why,
  risk: "low",
  riskReasons: [],
  observed: null,
  findings: [],
  tests: null,
  ai: null,
  reviewedAs: null,
  bundled: [],
  builtAt: Date.now(),
  ...extra
});

const rejected = (manifest: Manifest | null, why: string, extra: Partial<ReviewReport> = {}): Outcome => ({
  status: "rejected",
  tier: null,
  risk: "low",
  riskReasons: [],
  report: emptyReport(why, extra),
  manifest,
  digest: null,
  attestation: null,
  packagePath: null,
  packageSize: null,
  reviewedAs: null
});

/**
 * One submission, from its commit to a decision: fetch exactly that tree,
 * install production dependencies without their scripts, build, test in the
 * sandbox, read the code, ask the model, apply the rules, and — when it is
 * listed — sign what was built and upload it.
 */
export async function reviewSubmission(sub: Submission, deps: PipelineDeps): Promise<Outcome> {
  const base = path.join(deps.workDir, sub.id);
  const dir = path.join(base, "source");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sandbox = { execPath: deps.execPath };
  try {
    await deps.registry.progress(sub, "building");
    await deps.fetchSource(sub.repository, sub.commit_sha, dir);
    let manifest: Manifest;
    try {
      manifest = readManifest(dir);
    } catch (error) {
      return rejected(null, `tomrade-plugin.json is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (manifest.id !== sub.plugin_id || manifest.version !== sub.version) return rejected(manifest, `the commit holds ${manifest.id} ${manifest.version}, not ${sub.plugin_id} ${sub.version}`);
    if (manifest.repository?.replace(/\.git$/, "") !== sub.repository.replace(/\.git$/, "")) return rejected(manifest, "the manifest names a different repository than the one submitted");

    const pkg = fs.existsSync(path.join(dir, "package.json")) ? (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }) : {};
    if (Object.keys(pkg.dependencies ?? {}).length) {
      if (!["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some((f) => fs.existsSync(path.join(dir, f)))) return rejected(manifest, "a plugin with dependencies must commit its lockfile, so the store builds what the author tested");
      if (!deps.installDependencies) return rejected(manifest, "this review worker does not install dependencies");
      await deps.installDependencies(dir);
    }

    const checked: CheckReport = await check(dir, sandbox);
    manifest = checked.manifest ?? manifest;
    if (checked.problems.length) return rejected(manifest, `the plugin does not build or load cleanly:\n${checked.problems.join("\n")}`, { findings: checked.analysis?.findings ?? [] });
    const publishing = publishingProblems(dir, manifest);
    if (publishing.length) return rejected(manifest, publishing.join("\n"));
    const tests: TestResult = await test(dir, { ...sandbox, build: false });
    if (!tests.checks.find((c) => c.name === "loads")?.ok) return rejected(manifest, `the plugin does not load in a clean Tomrade: ${tests.error ?? tests.checks.find((c) => c.name === "loads")?.detail ?? ""}`, { tests });

    await deps.registry.progress(sub, "reviewing");
    const previous = await deps.registry.previousListed(sub.plugin_id, sub.version);
    let diff: { from: string; patch: string; fromReviewedByHuman: boolean } | null = null;
    if (previous) {
      const before = path.join(base, "previous");
      fs.mkdirSync(before, { recursive: true });
      await deps.fetchSource(sub.repository, previous.commit_sha, before);
      diff = { from: previous.version, patch: await sourceDiff(before, dir), fromReviewedByHuman: previous.tier === "reviewed" || previous.tier === "official" };
    }
    const analysis = checked.analysis!;
    const judged = await deps.judge({ manifest, analysis, tests, contributes: manifest.contributes as Record<string, string[] | undefined>, bundled: checked.build?.bundled ?? [], files: sourceFiles(dir), diff });
    const decision = decide(judged, analysis);
    const risk = observedRisk(analysis.observed, manifest);
    const reviewedAs = decision.status === "listed" ? carryOver(previous, judged, expansion(previous?.manifest ?? null, manifest)) : null;
    const tier = decision.status === "listed" ? (reviewedAs ? "reviewed" : "ai-reviewed") : null;

    const report: ReviewReport = {
      v: 1,
      verdict: decision.status,
      summary: judged.verdict?.summary ?? decision.why,
      risk: risk.level,
      riskReasons: risk.reasons,
      observed: analysis.observed,
      findings: analysis.findings,
      tests,
      ai: judged.verdict
        ? { model: judged.model, summary: judged.verdict.summary, malicious: judged.verdict.malicious, matchesDescription: judged.verdict.matchesDescription, concerns: judged.verdict.concerns, promptInjection: judged.verdict.promptInjection, diff: judged.verdict.diff && diff ? { from: diff.from, ...judged.verdict.diff } : null }
        : null,
      reviewedAs,
      bundled: checked.build?.bundled ?? [],
      builtAt: Date.now()
    };
    if (decision.status === "rejected") return { ...rejected(manifest, decision.why), report: { ...report, summary: `${decision.why}. ${report.summary}` } };

    // Built and packed either way; only a listed version is signed now. A held one is signed when a person approves it.
    fs.rmSync(path.join(dir, ATTESTATION_FILE), { force: true });
    const { digest } = await packPlugin(dir, path.join(base, "unsigned.tomrade-plugin"));
    let attestation: Attestation | null = null;
    if (decision.status === "listed") {
      attestation = attest({ v: 1, id: manifest.id, version: manifest.version, digest, tier: tier!, risk: risk.level, issuedAt: Date.now() }, deps.signingKey);
      writeAttestation(dir, attestation);
    }
    const out = path.join(base, "package.tomrade-plugin");
    await packPlugin(dir, out);
    const bytes = fs.readFileSync(out);
    const packagePath = `${manifest.id}/${manifest.version}/${digest}.tomrade-plugin`;
    await deps.registry.upload(packagePath, bytes);
    return { status: decision.status, tier, risk: risk.level, riskReasons: risk.reasons, report, manifest, digest, attestation, packagePath, packageSize: bytes.length, reviewedAs };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Claims nothing itself: runs one submission and records the result, whatever happens. */
export async function processSubmission(sub: Submission, deps: PipelineDeps): Promise<Outcome | null> {
  try {
    const outcome = await reviewSubmission(sub, deps);
    await deps.registry.finish(sub, outcome);
    return outcome;
  } catch (error) {
    await deps.registry.fail(sub, error instanceof Error ? error.message : String(error));
    return null;
  }
}

export type { Verdict };
