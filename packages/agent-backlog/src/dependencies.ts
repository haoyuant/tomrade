import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/db";
import type {} from "@tomradex/items";
import type { Author, Item } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import { overlap } from "./similar.js";

type Snapshot = Partial<Pick<Item, "id" | "key" | "title" | "kind" | "status" | "body" | "parentId" | "blocks" | "blockedBy">>;

/** A ticket an agent changed in a way that can move its dependencies, with the edges it had. */
export interface TicketChange {
  key: string;
  title: string;
  what: string[];
  blocks: string[];
  blockedBy: string[];
}

const closed = (status?: string) => status === "done" || status === "cancelled";

/**
 * What these runs did to tickets that can matter for dependencies: tickets
 * created, deleted, cancelled, retitled, moved to another epic, or whose body
 * was rewritten. Status moves, priorities, labels and dependency edits
 * themselves are not.
 */
export function ticketChanges(ctx: Context, projectId: string, runIds: string[]): TicketChange[] {
  if (!runIds.length || !ctx.db.has(projectId)) return [];
  const rows = ctx.db
    .for(projectId)
    .prepare(`SELECT entity_id, before_json, after_json FROM oplog WHERE entity = 'item' AND run_id IN (${runIds.map(() => "?").join(", ")}) ORDER BY seq`)
    .all(...runIds) as { entity_id: string; before_json: string | null; after_json: string | null }[];
  const net = new Map<string, { first: Snapshot | null; last: Snapshot | null }>();
  for (const row of rows) {
    const before = row.before_json ? (JSON.parse(row.before_json) as Snapshot) : null;
    const after = row.after_json ? (JSON.parse(row.after_json) as Snapshot) : null;
    const seen = net.get(row.entity_id);
    if (seen) seen.last = after;
    else net.set(row.entity_id, { first: before, last: after });
  }
  const keyOf = keysOf(ctx, projectId, [...net.values()].flatMap((n) => [n.first, n.last]));
  const keys = (ids?: string[]) => (ids ?? []).map((id) => keyOf.get(id)).filter((k): k is string => !!k);
  const changes: TicketChange[] = [];
  for (const { first, last } of net.values()) {
    const snap = last ?? first;
    if (!snap?.key || (snap.kind && snap.kind !== "ticket")) continue;
    const what: string[] = [];
    if (!first && last) what.push("created");
    else if (first && !last) what.push("deleted");
    else if (first && last) {
      if (last.status === "cancelled" && first.status !== "cancelled") what.push("cancelled");
      if (first.title && last.title && first.title !== last.title) what.push(`retitled from "${first.title}"`);
      if ((first.parentId ?? null) !== (last.parentId ?? null)) what.push("moved to another epic");
      if ((first.body ?? "") !== (last.body ?? "") && overlap(first.body ?? "", last.body ?? "") < 0.5) what.push("goal rewritten");
    }
    if (!what.length) continue;
    // A deleted ticket has lost its edges by now; its last snapshot still names them.
    const edges = last ?? first!;
    changes.push({ key: snap.key, title: snap.title ?? "", what, blocks: keys(edges.blocks), blockedBy: keys(edges.blockedBy) });
  }
  return changes;
}

function keysOf(ctx: Context, projectId: string, snapshots: (Snapshot | null)[]): Map<string, string> {
  const map = new Map(ctx.items.list({ projectId }).map((i) => [i.id, i.key] as const));
  for (const s of snapshots) if (s?.id && s.key && !map.has(s.id)) map.set(s.id, s.key);
  return map;
}

/** Named for what they mean: "from/to" left a model unsure which way an edge points. */
const edgeSchema = z.object({ prerequisite: z.string(), dependent: z.string(), reason: z.string().catch("") });
export const dependencyReviewSchema = z.object({ add: z.array(edgeSchema).catch([]), remove: z.array(edgeSchema).catch([]) });

export interface DependencyEdit {
  from: string;
  to: string;
  fromId: string;
  toId: string;
  reason: string;
}

export interface DependencyProposal {
  add: DependencyEdit[];
  remove: DependencyEdit[];
}

const REVIEW_SYSTEM = [
  "You keep the dependencies between backlog tickets right. A dependency has a prerequisite and a dependent: the dependent cannot be finished until the prerequisite is done.",
  "Given what just changed and the open backlog, propose the dependency edits those changes call for:",
  "- new tickets: which need another ticket done first (a shared data model before the features that store into it, an import before the views that show what it imported), and which other tickets now need them;",
  "- a cancelled or deleted ticket's dependencies carried over to the ticket that replaces it, when one does;",
  "- dependencies that a changed goal made wrong.",
  "Add one only when the dependent truly cannot be finished without the prerequisite. Being related, sharing an epic or a preferred order is not enough, and when any one of several tickets would do (one data source is enough to build a view), depend on none of them. Return empty lists when nothing qualifies.",
  "Use only keys from the backlog list. Each reason is one short sentence, in the language of the tickets, saying what the dependent needs from the prerequisite.",
  'Return JSON: {"add": [{"prerequisite": "KEY", "dependent": "KEY", "reason": "..."}], "remove": [{"prerequisite": "KEY", "dependent": "KEY", "reason": "..."}]}'
].join("\n");

const LIMIT = 80;
/** The review is a nicety after the turn: one that takes longer is skipped rather than held open. */
export const REVIEW_TIMEOUT_MS = 30_000;

/** The worker's judgement on these changes, cut down to edits that can actually be applied. */
export async function proposeDependencies(ctx: Context, llm: LlmService, projectId: string, changes: TicketChange[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DependencyProposal> {
  const items = ctx.items.list({ projectId });
  const byId = new Map(items.map((i) => [i.id, i]));
  const tickets = items.filter((i) => i.kind === "ticket");
  const changed = new Set(changes.map((c) => c.key));
  const near = new Set(changes.flatMap((c) => [...c.blocks, ...c.blockedBy]));
  const parents = new Set(tickets.filter((t) => changed.has(t.key)).map((t) => t.parentId));
  const rank = (t: Item) => (changed.has(t.key) ? 0 : near.has(t.key) ? 1 : parents.has(t.parentId) ? 2 : 3);
  const listed = tickets
    .filter((t) => !closed(t.status) || changed.has(t.key) || near.has(t.key))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, LIMIT);
  const line = (t: Item) => {
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    const blocks = t.blocks.map((id) => byId.get(id)?.key).filter(Boolean);
    return `- ${t.key} [${t.status}${parent ? `, epic ${parent.key}` : ""}] ${t.title}${blocks.length ? ` — blocks ${blocks.join(", ")}` : ""}`;
  };
  const edges = (c: TicketChange) => [c.blocks.length ? `it blocked ${c.blocks.join(", ")}` : "", c.blockedBy.length ? `it was blocked by ${c.blockedBy.join(", ")}` : ""].filter(Boolean).join("; ");
  const user = [
    "CHANGES:",
    ...(changes.length
      ? changes.map((c) => `- ${c.what.join(", ")}: ${c.key} "${c.title}"${edges(c) ? ` (${edges(c)})` : ""}`)
      : ["- none: the user asked for a full check, so propose what the backlog as a whole needs"]),
    "",
    "BACKLOG:",
    ...listed.map(line)
  ].join("\n");
  const review = await llm.completeJson(dependencyReviewSchema, { system: REVIEW_SYSTEM, user, signal: opts.signal, timeoutMs: opts.timeoutMs ?? REVIEW_TIMEOUT_MS, purpose: "dependencies" });
  return applicable(review, tickets);
}

/** Known open tickets, no self-loops, nothing already true, nothing that closes a cycle. */
function applicable(review: z.infer<typeof dependencyReviewSchema>, tickets: Item[]): DependencyProposal {
  const byKey = new Map(tickets.map((t) => [t.key.toUpperCase(), t]));
  const blocksOf = new Map(tickets.map((t) => [t.id, new Set(t.blocks)]));
  const resolve = (e: z.infer<typeof edgeSchema>) => {
    const from = byKey.get(e.prerequisite.trim().toUpperCase());
    const to = byKey.get(e.dependent.trim().toUpperCase());
    return from && to && from.id !== to.id ? { from: from.key, to: to.key, fromId: from.id, toId: to.id, reason: e.reason.trim(), fromItem: from, toItem: to } : null;
  };
  const remove: DependencyEdit[] = [];
  for (const e of review.remove) {
    const edit = resolve(e);
    if (!edit || !blocksOf.get(edit.fromId)?.has(edit.toId) || remove.some((r) => r.fromId === edit.fromId && r.toId === edit.toId)) continue;
    blocksOf.get(edit.fromId)!.delete(edit.toId);
    remove.push(strip(edit));
  }
  let add: DependencyEdit[] = [];
  for (const e of review.add) {
    const edit = resolve(e);
    if (!edit || closed(edit.toItem.status) || edit.fromItem.status === "cancelled" || blocksOf.get(edit.fromId)?.has(edit.toId)) continue;
    if (reaches(edit.toId, edit.fromId, blocksOf)) continue;
    blocksOf.get(edit.fromId)!.add(edit.toId);
    add.push(strip(edit));
  }
  // An edge whose order already follows from the others says nothing new; asking about it is noise.
  for (const edit of [...add]) {
    blocksOf.get(edit.fromId)!.delete(edit.toId);
    if (reaches(edit.fromId, edit.toId, blocksOf)) add = add.filter((a) => a !== edit);
    else blocksOf.get(edit.fromId)!.add(edit.toId);
  }
  return { add: add.slice(0, 12), remove: remove.slice(0, 12) };
}

const strip = ({ from, to, fromId, toId, reason }: DependencyEdit): DependencyEdit => ({ from, to, fromId, toId, reason });

function reaches(start: string, target: string, blocksOf: Map<string, Set<string>>): boolean {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.pop()!;
    if (node === target) return true;
    for (const next of blocksOf.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** One write per blocking ticket; a refusal (a lock, a cycle someone else just made) is reported, not thrown. */
export function applyDependencies(ctx: Context, projectId: string, proposal: DependencyProposal, by: Author): { added: number; removed: number; failed: { key: string; reason: string }[] } {
  const touched = new Set([...proposal.add, ...proposal.remove].map((e) => e.fromId));
  let added = 0;
  let removed = 0;
  const failed: { key: string; reason: string }[] = [];
  for (const fromId of touched) {
    const item = ctx.items.get(projectId, fromId);
    if (!item) continue;
    const adds = proposal.add.filter((e) => e.fromId === fromId && !item.blocks.includes(e.toId)).map((e) => e.toId);
    const drops = new Set(proposal.remove.filter((e) => e.fromId === fromId && item.blocks.includes(e.toId)).map((e) => e.toId));
    if (!adds.length && !drops.size) continue;
    try {
      ctx.items.update(projectId, fromId, { blocks: [...item.blocks.filter((id) => !drops.has(id)), ...adds] }, by);
      added += adds.length;
      removed += drops.size;
    } catch (err) {
      failed.push({ key: item.key, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { added, removed, failed };
}

const short = (title: string) => (title.length > 18 ? `${title.slice(0, 18).trimEnd()}…` : title);

/** The question and its two answers, in the language the tickets are written in. */
export function reviewQuestion(proposal: DependencyProposal, titleOf: (key: string) => string, zh: boolean): { text: string; apply: string; skip: string } {
  const edit = (sign: string, e: DependencyEdit) => `${sign} ${e.from} ${short(titleOf(e.from))} → ${e.to} ${short(titleOf(e.to))}${e.reason ? (zh ? `：${e.reason}` : ` — ${e.reason}`) : ""}`;
  const lines = [...proposal.add.map((e) => edit("+", e)), ...proposal.remove.map((e) => edit("−", e))];
  return zh
    ? { text: ["刚才的改动影响到 ticket 之间的依赖（A → B：B 要等 A 完成）。建议：", ...lines, "现在更新吗？"].join("\n"), apply: "现在更新", skip: "暂不" }
    : { text: ["These changes affect dependencies between tickets (A → B: B waits for A). Suggested:", ...lines, "Update them now?"].join("\n"), apply: "Update now", skip: "Not now" };
}
