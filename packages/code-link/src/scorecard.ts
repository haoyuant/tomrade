import type { CodeLinkView, DeliveryView, SessionView } from "./store.js";

/** A run of an in-app conversation on the ticket, as the agent store keeps it. */
export interface ScorecardRun {
  threadId: string;
  engine: string;
  status: string;
  startedAt: number;
  costUsd: number | null;
}

/** What one project holds for a scorecard: its code links and deliveries, and the sessions, conversations and runs on the tickets they name. */
export interface ScorecardSource {
  projectId: string;
  links: CodeLinkView[];
  deliveries: DeliveryView[];
  sessions: SessionView[];
  threads: { id: string; engine: string; itemId: string | null }[];
  runs: ScorecardRun[];
  keys: Map<string, string>;
}

/** One merged pull request, with everything its row is computed from. */
export interface ScorecardPr {
  projectId: string;
  itemId: string;
  itemKey: string | null;
  delivery: number;
  repoId: string;
  prNumber: number | null;
  prUrl: string | null;
  /** When its delivery completed, else when the link last changed. */
  mergedAt: number;
  /** The engine that wrote it; "" when no conversation or session on the ticket said. */
  engine: string;
  /** Delivered once: the ticket's first delivery, never reopened, and no pull request on it closed unmerged. */
  firstPass: boolean;
  /** This engine's priced runs on the delivery, split evenly between the delivery's merged pull requests; null when none was priced. */
  costUsd: number | null;
  pricedRuns: number;
  unpricedRuns: number;
}

export interface ScorecardTally {
  prs: number;
  firstPass: number;
  /** Null without a merged pull request. */
  firstPassRate: number | null;
}

export interface ScorecardEngine extends ScorecardTally {
  engine: string;
  title: string;
  /** Pull requests with at least one priced run. */
  pricedPrs: number;
  /** Over the priced pull requests only; null when none was priced — never a zero. */
  costUsd: number | null;
  costPerPrUsd: number | null;
}

export interface Scorecard {
  from: number;
  to: number;
  engines: ScorecardEngine[];
  /** Spend is left out of the total: engines price differently, and some never say. */
  totals: ScorecardTally;
  prs: ScorecardPr[];
}

const MICRO = 1_000_000;

export const isMergedPr = (l: CodeLinkView): boolean => (l.prUrl !== null || l.prNumber !== null) && (l.prState === "merged" || l.mergedSha !== null);
const isAbandonedPr = (l: CodeLinkView): boolean => (l.prUrl !== null || l.prNumber !== null) && l.prState === "closed" && l.mergedSha === null;

/** The merged pull requests of one project whose delivery completed inside [from, to]. */
export function scorecardPrs(src: ScorecardSource, from: number, to: number): ScorecardPr[] {
  const deliveries = new Map(src.deliveries.map((d) => [`${d.itemId} ${d.sequence}`, d]));
  const lastSequence = new Map<string, number>();
  for (const d of src.deliveries) lastSequence.set(d.itemId, Math.max(lastSequence.get(d.itemId) ?? 0, d.sequence));
  const abandoned = new Set(src.links.filter(isAbandonedPr).map((l) => l.itemId));
  const threadEngine = new Map(src.threads.map((t) => [t.id, t.engine]));
  const merged = src.links.filter(isMergedPr);
  const perDelivery = new Map<string, number>();
  for (const l of merged) perDelivery.set(`${l.itemId} ${l.delivery}`, (perDelivery.get(`${l.itemId} ${l.delivery}`) ?? 0) + 1);

  const out: ScorecardPr[] = [];
  for (const link of merged) {
    const delivery = deliveries.get(`${link.itemId} ${link.delivery}`) ?? null;
    const mergedAt = delivery?.completedAt ?? link.updatedAt;
    if (mergedAt < from || mergedAt > to) continue;
    const engine = engineOf(link, src, threadEngine);
    const startedAt = delivery?.startedAt ?? link.createdAt;
    const itemThreads = new Set(src.threads.filter((t) => t.itemId === link.itemId).map((t) => t.id));
    const runs = engine
      ? src.runs.filter((r) => itemThreads.has(r.threadId) && r.engine === engine && r.status !== "running" && r.startedAt >= startedAt && r.startedAt <= mergedAt)
      : [];
    const priced = runs.filter((r) => r.costUsd !== null);
    const share = perDelivery.get(`${link.itemId} ${link.delivery}`) ?? 1;
    const micro = priced.reduce((sum, r) => sum + Math.round(r.costUsd! * MICRO), 0);
    out.push({
      projectId: src.projectId,
      itemId: link.itemId,
      itemKey: src.keys.get(link.itemId) ?? null,
      delivery: link.delivery,
      repoId: link.repoId,
      prNumber: link.prNumber,
      prUrl: link.prUrl,
      mergedAt,
      engine,
      firstPass: link.delivery === 1 && (lastSequence.get(link.itemId) ?? 1) === 1 && !abandoned.has(link.itemId),
      costUsd: priced.length ? Math.round(micro / share) / MICRO : null,
      pricedRuns: priced.length,
      unpricedRuns: runs.length - priced.length
    });
  }
  return out;
}

/** The conversation the link names, else the newest session on that delivery, else the newest conversation on the ticket. */
function engineOf(link: CodeLinkView, src: ScorecardSource, threadEngine: Map<string, string>): string {
  const linked = link.threadId ? threadEngine.get(link.threadId) : undefined;
  if (linked) return linked;
  const session = src.sessions
    .filter((s) => s.delivery === link.delivery && (s.itemIds.includes(link.itemId) || s.worked.some((w) => w.itemId === link.itemId && w.delivery === link.delivery)))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (session) return (session.threadId && threadEngine.get(session.threadId)) || session.agent;
  return src.threads.find((t) => t.itemId === link.itemId)?.engine ?? "";
}

const tally = (prs: ScorecardPr[]): ScorecardTally => {
  const firstPass = prs.filter((p) => p.firstPass).length;
  return { prs: prs.length, firstPass, firstPassRate: prs.length ? firstPass / prs.length : null };
};

/** Each engine's merged pull requests, first-pass rate and spend per priced pull request, busiest first. */
export function summarizeScorecard(prs: ScorecardPr[], opts: { from: number; to: number; titles: Map<string, string> }): Scorecard {
  const byEngine = new Map<string, ScorecardPr[]>();
  for (const p of prs) byEngine.set(p.engine, [...(byEngine.get(p.engine) ?? []), p]);
  const engines = [...byEngine.entries()].map(([engine, rows]): ScorecardEngine => {
    const priced = rows.filter((p) => p.costUsd !== null);
    const micro = priced.reduce((sum, p) => sum + Math.round(p.costUsd! * MICRO), 0);
    return {
      engine,
      title: opts.titles.get(engine) ?? engine,
      ...tally(rows),
      pricedPrs: priced.length,
      costUsd: priced.length ? micro / MICRO : null,
      costPerPrUsd: priced.length ? Math.round(micro / priced.length) / MICRO : null
    };
  });
  engines.sort((a, b) => b.prs - a.prs || (a.engine === "" ? 1 : 0) - (b.engine === "" ? 1 : 0) || a.title.localeCompare(b.title));
  return { from: opts.from, to: opts.to, engines, totals: tally(prs), prs: [...prs].sort((a, b) => b.mergedAt - a.mergedAt) };
}
