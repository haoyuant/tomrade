import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { arrangements, unplaced } from "./layout.js";

/** Installation is product-owned and reproducible across engines and resumes. */
export const ARCHIFY_REVISION = "d673e8300df60a5c8166abe78787fdc78f6b8000";
const REPOSITORY = "https://github.com/tt-a1i/archify.git";
const exec = promisify(execFile);
export const diagramTypes = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type DiagramType = typeof diagramTypes[number];
export type Quality = "standard" | "showcase";
type Spec = Record<string, unknown>;
interface Diagnostic { code?: string; severity?: string; message?: string; subject?: { id?: string; from?: string; to?: string }; supportedFixes?: string[] }
interface Placement { spec: Spec; quality: Quality; showcaseIssues?: number }

const diagnosticsOf = (raw: unknown): Diagnostic[] =>
  raw && typeof raw === "object" && Array.isArray((raw as { diagnostics?: unknown }).diagnostics) ? (raw as { diagnostics: Diagnostic[] }).diagnostics : [];

/**
 * What a model needs to repair, in a few thousand characters. Raw diagnostics ran to 45k on a
 * dense diagram; the loop keeps 6k of a tool result, so the model repaired the first few errors blind.
 */
export function briefDiagnostics(raw: unknown) {
  const items = diagnosticsOf(raw);
  if (!items.length) return typeof raw === "string" ? raw.slice(0, 2000) : raw;
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.code ?? "unknown"] = (counts[item.code ?? "unknown"] ?? 0) + 1;
  return {
    errors: items.length,
    counts,
    first: items.slice(0, 8).map((item) => ({
      code: item.code,
      subject: item.subject?.id ?? (item.subject?.from ? `${item.subject.from} -> ${item.subject.to}` : undefined),
      message: (item.message ?? "").split("\n").slice(0, 2).join(" ").slice(0, 360),
      fix: item.supportedFixes?.[0]
    })),
    ...(items.length > 8 ? { more: `${items.length - 8} more; fix these first, then render again` } : {})
  };
}
const examples: Record<DiagramType, string> = {
  architecture: "web-app.architecture.json",
  workflow: "agent-tool-call.workflow.json",
  sequence: "cache-miss-request.sequence.json",
  dataflow: "product-analytics.dataflow.json",
  lifecycle: "agent-run.lifecycle.json"
};

export class ArchifyRuntime {
  private installation?: Promise<string>;
  constructor(private readonly cacheDirectory: string, private readonly nodeBinary = process.execPath) {}

  /** A failed install can retry; no task ever updates a previously selected revision. */
  ensureInstalled(): Promise<string> {
    if (!this.installation) this.installation = this.install().catch(error => {
      this.installation = undefined;
      throw error;
    });
    return this.installation;
  }

  private async install(): Promise<string> {
    const target = path.join(this.cacheDirectory, ARCHIFY_REVISION);
    const skill = path.join(target, "archify");
    try {
      const head = await exec("git", ["-C", target, "rev-parse", "HEAD"]);
      if (head.stdout.trim() !== ARCHIFY_REVISION) throw new Error("Unexpected Archify revision");
      await fs.access(path.join(skill, "bin/archify.mjs"));
      return skill;
    } catch (error) {
      try { await fs.access(target); } catch { return this.installFresh(target); }
      throw error;
    }
  }

  private async installFresh(target: string): Promise<string> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.cacheDirectory, "install-"));
    try {
      const options = { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };
      await exec("git", ["init", staging], options);
      await exec("git", ["-C", staging, "fetch", "--depth=1", REPOSITORY, ARCHIFY_REVISION], options);
      await exec("git", ["-C", staging, "checkout", "--detach", "FETCH_HEAD"], options);
      await this.command(path.join(staging, "archify"), ["doctor"]);
      try { await fs.rename(staging, target); } catch (error) {
        // Another app process may have installed the same revision while we fetched.
        const head = await exec("git", ["-C", target, "rev-parse", "HEAD"]);
        if (head.stdout.trim() !== ARCHIFY_REVISION) throw error;
      }
      return path.join(target, "archify");
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private command(skill: string, args: string[], signal?: AbortSignal) {
    return exec(this.nodeBinary, [path.join(skill, "bin/archify.mjs"), ...args], {
      cwd: skill, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ARCHIFY_UPDATE_CHECK_DISABLED: "1" }
    });
  }

  async schema(type: DiagramType) {
    if (!diagramTypes.includes(type)) throw new Error("Unknown diagram type");
    const skill = await this.ensureInstalled();
    const read = async (name: string) => JSON.parse(await fs.readFile(path.join(skill, name), "utf8"));
    return {
      revision: ARCHIFY_REVISION, type,
      schema: await read(`schemas/${type}.schema.json`),
      common: await read("schemas/common.schema.json"),
      example: await read(`examples/${examples[type]}`)
    };
  }

  private async check(skill: string, type: DiagramType, spec: Spec, quality: Quality, directory: string, signal?: AbortSignal) {
    const file = path.join(directory, `candidate-${randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify(spec));
    try {
      await this.command(skill, ["validate", type, file, "--quality", quality, "--json"], signal);
      return { ok: true, diagnostics: [] as Diagnostic[] };
    } catch (error) {
      signal?.throwIfAborted();
      let raw: unknown;
      try { raw = JSON.parse((error as { stdout?: string }).stdout ?? ""); } catch { raw = undefined; }
      return { ok: false, diagnostics: diagnosticsOf(raw) };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  /**
   * The best automatic placement: at showcase quality when a candidate reaches it, at standard
   * when only that holds (dense maps keep a few edge crossings that only showcase rejects).
   */
  private async place(skill: string, spec: Spec, directory: string, signal?: AbortSignal): Promise<Placement> {
    const candidates = arrangements(spec);
    const scored: { spec: Spec; errors: number; width: number; standard: boolean }[] = [];
    const asStandard = (candidate: Spec) => ({ ...candidate, meta: { ...(candidate.meta as Spec), quality_profile: "standard" } });
    for (let i = 0; i < candidates.length; i += 4) {
      const batch = candidates.slice(i, i + 4);
      const checks = await Promise.all(batch.map((candidate) => this.check(skill, "architecture", candidate, "showcase", directory, signal)));
      for (const [j, result] of checks.entries()) {
        if (result.ok) return { spec: batch[j]!, quality: "showcase" };
        // Wrong fields, not wrong places: every candidate shares them, and only the author can fix them.
        if (result.diagnostics.some((d) => d.code?.startsWith("schema/"))) return { spec: asStandard(batch[j]!), quality: "standard" };
      }
      const standard = await Promise.all(batch.map((candidate) => this.check(skill, "architecture", asStandard(candidate), "standard", directory, signal)));
      for (const [j, result] of checks.entries())
        scored.push({ spec: asStandard(batch[j]!), errors: result.diagnostics.length, width: ((batch[j]!.meta as Spec).viewBox as number[])[0]!, standard: standard[j]!.ok });
    }
    // Holds at standard first; then closest to showcase; then the narrower, since the viewer fits the width and a wide map reads small.
    scored.sort((a, b) => Number(b.standard) - Number(a.standard) || a.errors - b.errors || a.width - b.width);
    const pick = scored[0];
    if (!pick) return { spec, quality: "showcase" };
    // If even that fails, it is delivered at standard so the few blocking errors are the ones reported.
    return { spec: pick.spec, quality: "standard", ...(pick.standard ? { showcaseIssues: pick.errors } : {}) };
  }

  /**
   * Caller provides a fresh artifact directory, never an arbitrary output filename.
   * A placed specification renders exactly as written, one delivery, raw diagnostics — the path
   * Claude Code and Codex reach showcase on. Automatic layout is only for an architecture sent
   * without coordinates, or one the caller asks to arrange after its placement kept failing.
   */
  async render(type: DiagramType, spec: Spec, directory: string, signal?: AbortSignal, { arrange = false }: { arrange?: boolean } = {}) {
    if (!diagramTypes.includes(type)) throw new Error("Unknown diagram type");
    const skill = await this.ensureInstalled();
    signal?.throwIfAborted();
    await fs.mkdir(directory, { recursive: true });
    const automatic = type === "architecture" && (arrange || unplaced(spec));
    const placement: Placement = automatic ? await this.place(skill, spec, directory, signal) : { spec, quality: "showcase" };
    const source = path.join(directory, "diagram.json");
    const artifact = path.join(directory, "diagram.html");
    await fs.writeFile(source, JSON.stringify(placement.spec, null, 2), { flag: "wx" });
    try {
      const result = await this.command(skill, ["deliver", type, source, artifact, "--quality", placement.quality, "--json"], signal);
      const delivered = { ok: true as const, source, artifact, receipt: JSON.parse(result.stdout), revision: ARCHIFY_REVISION };
      return automatic ? { ...delivered, layout: "automatic" as const, quality: placement.quality, ...(placement.showcaseIssues ? { showcaseIssues: placement.showcaseIssues } : {}) } : delivered;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      let diagnostics: unknown;
      try { diagnostics = JSON.parse(failure.stdout ?? ""); } catch { diagnostics = failure.stderr || failure.message || String(error); }
      return { ok: false as const, diagnostics: automatic ? briefDiagnostics(diagnostics) : diagnostics, revision: ARCHIFY_REVISION };
    }
  }
}
