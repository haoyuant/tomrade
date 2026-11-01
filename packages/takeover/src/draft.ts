import { z } from "zod";
import { findGaps, findSimilarBatch, overlap } from "@tomradex/agent-backlog";
import { languageName, type Item, type LanguageTag } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import type { BranchFact, IssueFact, SessionFact, WorktreeFact } from "./facts.js";
import type { TakeoverWords } from "./words.js";

export type TakeoverSourceKind = "branch" | "worktree" | "issue" | "session";

/** One thing the scan saw, enough to find it again. */
export interface TakeoverSource {
  kind: TakeoverSourceKind;
  /** Says what kind it is: "Branch", "Claude Code session". */
  label: string;
  repoName: string;
  /** The branch, the folder, owner/repo#n, or the record's file. */
  ref: string;
  url: string | null;
  detail: string;
}

export interface TakeoverEntry {
  id: string;
  title: string;
  summary: string;
  sources: TakeoverSource[];
  /** Entries this one needs first. */
  dependsOn: string[];
  /** A ticket that may already hold this. */
  similar: { key: string; title: string; verdict: "duplicate" | "related" } | null;
  /** The backlog seems to hold this already, by a model's reading, though no one ticket matches. */
  covered: boolean;
  /** Set where ticking it should link a branch. */
  repoId: string | null;
  branch: string | null;
}

export interface Facts {
  branches: BranchFact[];
  worktrees: WorktreeFact[];
  issues: IssueFact[];
  sessions: SessionFact[];
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

/** The issue numbers a branch's name or commits point at. */
export function issueNumbers(branch: BranchFact): Set<number> {
  const found = new Set<number>();
  for (const m of branch.branch.matchAll(/(?:issue|gh)[-_/]?(\d+)/gi)) found.add(Number(m[1]));
  for (const subject of branch.subjects) for (const m of subject.matchAll(/#(\d+)/g)) found.add(Number(m[1]));
  return found;
}

const worktreeDetail = (t: WorktreeFact, w: TakeoverWords) =>
  [t.branch ? w("worktreeOn", { branch: t.branch }) : "", t.dirty ? w("worktreeDirty", { n: t.dirty }) : "", !t.branch && t.ahead ? w("worktreeAhead", { n: t.ahead }) : "", w("worktreeTouched", { date: day(t.touchedAt) })].filter(Boolean).join(", ");

const sessionDetail = (s: SessionFact, w: TakeoverWords) => [w("sessionDetail", { date: day(s.at) }), w("sessionSaid", { text: s.lastSaid })].join("; ");

/**
 * The scan's facts as draft entries, one per piece of work: a branch collects
 * the worktree it is checked out in, the issue it closes and the sessions that
 * worked on it, so one piece of work is never ticked twice.
 */
export function buildEntries(facts: Facts, w: TakeoverWords): TakeoverEntry[] {
  const entries: TakeoverEntry[] = [];
  const add = (entry: Omit<TakeoverEntry, "dependsOn" | "similar" | "covered">) => {
    const made = { ...entry, dependsOn: [], similar: null, covered: false };
    entries.push(made);
    return made;
  };
  const branchId = (repoId: string, branch: string) => `branch:${repoId}:${branch}`;
  const byBranch = new Map<string, TakeoverEntry>();
  for (const b of facts.branches) {
    const detail = [w("branchDetail", { ahead: b.ahead, base: b.base, date: day(b.committedAt) }), b.subjects.length ? w("branchSubjects", { subjects: b.subjects.join("; ") }) : ""].filter(Boolean).join("; ");
    const entry = add({
      id: branchId(b.repoId, b.branch),
      title: b.subjects.at(-1) ?? b.branch,
      summary: "",
      sources: [{ kind: "branch", label: w("sourceBranch"), repoName: b.repoName, ref: b.branch, url: null, detail }],
      repoId: b.repoId,
      branch: b.branch
    });
    byBranch.set(entry.id, entry);
  }
  for (const b of facts.branches) {
    if (b.parent) byBranch.get(branchId(b.repoId, b.branch))!.dependsOn.push(branchId(b.repoId, b.parent));
  }

  for (const t of facts.worktrees) {
    const source: TakeoverSource = { kind: "worktree", label: w("sourceWorktree"), repoName: t.repoName, ref: t.dir, url: null, detail: worktreeDetail(t, w) };
    const held = t.branch ? byBranch.get(branchId(t.repoId, t.branch)) : undefined;
    if (held) held.sources.push(source);
    else if (t.dirty || (!t.branch && t.ahead)) add({ id: `worktree:${t.dir}`, title: w("worktreeTitle", { name: folderName(t.dir) }), summary: "", sources: [source], repoId: null, branch: null });
  }

  const issueOf = new Map(facts.branches.flatMap((b) => [...issueNumbers(b)].map((n) => [`${b.repoId}#${n}`, byBranch.get(branchId(b.repoId, b.branch))!] as const)));
  for (const i of facts.issues) {
    const source: TakeoverSource = { kind: "issue", label: w("sourceIssue"), repoName: i.repoName, ref: i.ref, url: i.url, detail: i.reporter ? w("issueDetail", { who: i.reporter }) : "" };
    const held = issueOf.get(`${i.repoId}#${i.number}`);
    if (held) held.sources.push(source);
    else add({ id: `issue:${i.ref}`, title: i.title, summary: i.body.trim().slice(0, 500), sources: [source], repoId: null, branch: null });
  }

  for (const s of facts.sessions) {
    const source: TakeoverSource = { kind: "session", label: w("sourceSession", { agent: s.agentTitle }), repoName: s.repoName, ref: s.file, url: null, detail: sessionDetail(s, w) };
    const held = s.branch ? byBranch.get(branchId(s.repoId, s.branch)) : undefined;
    if (held) held.sources.push(source);
    else add({ id: `session:${s.file}`, title: s.title, summary: w("sessionUnjudged"), sources: [source], repoId: null, branch: null });
  }
  withoutCycles(entries);
  return entries;
}

/** An edge to nothing, or one that would make a cycle, is left out: a draft's dependencies must be ones the backlog can hold. */
function withoutCycles(entries: TakeoverEntry[]): void {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((d) => reaches(d, to, seen));
  };
  for (const entry of entries) {
    const wanted = [...new Set(entry.dependsOn)];
    entry.dependsOn = [];
    for (const dep of wanted) if (byId.has(dep) && !reaches(dep, entry.id)) entry.dependsOn.push(dep);
  }
}

const organizeSchema = z.object({
  entries: z.array(
    z.object({
      label: z.string(),
      title: z.string().optional().catch(undefined),
      summary: z.string().optional().catch(undefined),
      finished: z.boolean().optional().catch(undefined),
      dependsOn: z.array(z.string()).optional().catch(undefined)
    })
  )
});

const ORGANIZE_SYSTEM = (language: string) =>
  [
    "You turn what a scan found in a code repository into a draft backlog that a person will review.",
    "Each ENTRY is real work found in git, GitHub or a coding agent's session. Answer for every entry, by its label:",
    `- title: a short, specific ticket title in ${language}, saying the outcome, without prefixes.`,
    `- summary: one or two sentences in ${language}: what was being done and what seems left. Say only what the entry shows.`,
    "- finished: true only for an entry made of a session that clearly reached its end with nothing left to do; otherwise false.",
    "- dependsOn: labels of entries that must be done before this one, only where the entries themselves show it.",
    'Return JSON only: {"entries":[{"label","title","summary","finished","dependsOn"}]}'
  ].join("\n");

/** Most entries one model call reads. */
const MODEL_ENTRIES = 60;

/** Everything `organize` sends: named here so what a person agrees to and what goes out are the same list. */
export function entryForModel(entry: TakeoverEntry, label: string, facts: Facts): string {
  const excerpts = entry.sources.flatMap((s) => (s.kind === "session" ? [facts.sessions.find((f) => f.file === s.ref)?.excerpt ?? ""] : []));
  return [`ENTRY ${label}: ${entry.title}`, ...entry.sources.map((s) => `  ${s.kind} ${s.kind === "session" ? "" : s.ref}: ${s.detail}`), entry.summary ? `  ${entry.summary}` : "", ...excerpts.map((e) => `  conversation's end:\n${e}`)].filter(Boolean).join("\n");
}

/** One worker call: better titles, what is left, sessions that finished, and dependencies git cannot see. Returns how many sessions it dropped. */
export async function organize(llm: LlmService, entries: TakeoverEntry[], facts: Facts, locale: LanguageTag): Promise<{ entries: TakeoverEntry[]; dropped: number }> {
  const sent = entries.slice(0, MODEL_ENTRIES);
  const labels = new Map(sent.map((e, i) => [`E${i + 1}`, e]));
  const user = [...labels].map(([label, e]) => entryForModel(e, label, facts)).join("\n\n");
  const out = await llm.completeJson(organizeSchema, { system: ORGANIZE_SYSTEM(languageName(locale)), user, maxTokens: 6000, timeoutMs: 180_000, purpose: "plan" });
  const finished = new Set<string>();
  for (const answer of out.entries) {
    const entry = labels.get(answer.label);
    if (!entry) continue;
    if (answer.title?.trim()) entry.title = answer.title.trim();
    if (answer.summary?.trim()) entry.summary = answer.summary.trim();
    if (answer.finished && entry.sources.every((s) => s.kind === "session")) finished.add(entry.id);
    for (const dep of answer.dependsOn ?? []) {
      const id = labels.get(dep)?.id;
      if (id) entry.dependsOn.push(id);
    }
  }
  const kept = entries.filter((e) => !finished.has(e.id));
  for (const e of kept) e.dependsOn = e.dependsOn.filter((d) => !finished.has(d));
  withoutCycles(kept);
  return { entries: kept, dropped: finished.size };
}

/** `find_similar` over the draft. Without leave for a model, `llm` is null and it stays on this machine. */
export async function markSimilar(llm: LlmService | null, entries: TakeoverEntry[], existing: Item[]): Promise<void> {
  if (!entries.length || !existing.length) return;
  const results = await findSimilarBatch(llm, entries.map((e) => ({ title: e.title })), existing, 1, { withinMs: 30_000 });
  entries.forEach((entry, i) => {
    const result = results[i];
    const match = result?.matches[0];
    if (match && result.verdict !== "none") entry.similar = { key: match.key, title: match.title, verdict: result.verdict };
  });
}

/** `find_gaps` over the draft: what it does not call missing, the backlog seems to hold already. */
export async function markCovered(llm: LlmService, entries: TakeoverEntry[], existing: Item[], brief: string | null): Promise<void> {
  const open = entries.filter((e) => !e.similar);
  if (!open.length || !existing.length) return;
  const requirement = ["Finish the work found in this repository. Keep each line's [E…] label in the title of any item you list as missing.", ...open.map((e, i) => `- [E${i + 1}] ${e.title}`)].join("\n");
  const gaps = await findGaps(llm, requirement, existing, brief);
  const missing = new Set(gaps.flatMap((g) => [...g.title.matchAll(/\[?E(\d+)\]?/g)].map((m) => Number(m[1]) - 1)));
  open.forEach((entry, i) => {
    entry.covered = !missing.has(i) && !gaps.some((g) => overlap(g.title, entry.title) >= 0.3);
  });
}

/** A ticket's body: what is known, then every source, so the ticket can be traced back. */
export function ticketBody(entry: TakeoverEntry, w: TakeoverWords): string {
  const source = (s: TakeoverSource) => `- ${s.label} ${s.url ? `[${s.ref}](${s.url})` : `\`${s.ref}\``} (${s.repoName})${s.detail ? `: ${s.detail}` : ""}`;
  return [entry.summary, `## ${w("sourcesHeading")}`, entry.sources.map(source).join("\n")].filter(Boolean).join("\n\n");
}
