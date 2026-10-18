import type { Block } from "@tomradex/agent";
import type { ImContent, ImElement } from "@tomradex/plugin-sdk";
import type { ImPlainWord, ImSpeak } from "./words.js";

/** Opens the object in the desktop app; the app registers the `tomrade:` scheme. */
export const links = {
  item: (projectId: string, key: string) => `tomrade://item/${encodeURIComponent(projectId)}/${encodeURIComponent(key)}`,
  thread: (projectId: string, threadId: string) => `tomrade://thread/${encodeURIComponent(projectId)}/${encodeURIComponent(threadId)}`,
  file: (projectId: string, fileId: string) => `tomrade://file/${encodeURIComponent(projectId)}/${encodeURIComponent(fileId)}`
};

/** The part of the items service a reply reads: a changed ticket's current state. */
type ItemRow = { id: string; key: string; title: string; status: string; priority: number };
export interface ItemLookup { getByKey(projectId: string, key: string): ItemRow | null; get(projectId: string, id: string): ItemRow | null }

/** The part of `ctx.codeLink.summary` a reply reads: the ticket's code for its current delivery, primary link first. */
export interface CodeSummary {
  links: { branch: string | null; prNumber: number | null; prUrl: string | null; prState: "open" | "merged" | "closed" | null; mergedSha: string | null }[];
  session: { state: string; blocked: string | null } | null;
  proposals: { id: string; kind: "propose" | "flag"; toStatus: string | null; reason: string }[];
}
export interface CodeLookup { summary(projectId: string, itemId: string): CodeSummary }

export interface RenderScope { projectId: string; threadId: string; w: ImSpeak; items?: ItemLookup; code?: CodeLookup }

/** How many changed tickets get a card each; the rest are counted. */
const CARD_LIMIT = 8;

const STATUS: Partial<Record<string, ImPlainWord>> = {
  backlog: "statusBacklog", todo: "statusTodo", doing: "statusDoing",
  verifying: "statusVerifying", done: "statusDone", cancelled: "statusCancelled"
};
const PRIORITY: ImPlainWord[] = ["priorityNone", "priorityLow", "priorityMedium", "priorityHigh", "priorityUrgent"];
const OP: Partial<Record<string, ImPlainWord>> = { created: "opCreated", updated: "opUpdated", deleted: "opDeleted" };

const PR_STATE: Partial<Record<string, ImPlainWord>> = { open: "prOpen", merged: "merged", closed: "prClosed" };
const SESSION: Partial<Record<string, ImPlainWord>> = {
  running: "sessionRunning", waiting: "sessionWaiting", idle: "sessionIdle", error: "sessionError", lost: "sessionLost"
};
/** A stored value by its word, or as stored when it has none. */
const named = (w: ImSpeak, word: ImPlainWord | undefined, value: string) => word ? w(word) : value;

/** The code a card shows. Code link is optional: without it, or when it fails, the card is the ticket alone. */
function codeOf(scope: RenderScope, itemId: string): CodeSummary | null {
  try { return scope.code?.summary(scope.projectId, itemId) ?? null; } catch { return null; }
}

/** The primary branch and pull request, and the session at work, as card fields; the pull request's page as a link. */
export function codeFields(w: ImSpeak, code: CodeSummary | null): { fields: { label: string; value: string }[]; links: { label: string; url: string }[] } {
  const primary = code?.links[0];
  const fields: { label: string; value: string }[] = [];
  const urls: { label: string; url: string }[] = [];
  if (primary?.branch) fields.push({ label: w("branch"), value: primary.branch });
  if (primary && (primary.prNumber !== null || primary.prUrl)) {
    const state = primary.prState ? named(w, PR_STATE[primary.prState], primary.prState) : "";
    fields.push({ label: w("pullRequest"), value: [primary.prNumber !== null ? `#${primary.prNumber}` : "", state].filter(Boolean).join(" · ") });
    if (primary.prUrl && /^https?:\/\//.test(primary.prUrl)) urls.push({ label: primary.prNumber !== null ? w("pullRequestNumber", { n: primary.prNumber }) : w("pullRequest"), url: primary.prUrl });
  } else if (primary?.mergedSha) fields.push({ label: w("merged"), value: primary.mergedSha.slice(0, 7) });
  const session = code?.session;
  const sessionWord = session && SESSION[session.state];
  if (sessionWord) fields.push({ label: w("session"), value: session.blocked === "merge" ? w("mergeWaits") : w(sessionWord) });
  return { fields, links: urls };
}

export function statusText(w: ImSpeak, status: string): string {
  return named(w, STATUS[status], status);
}

/** A ticket as a card: key and title, its state and code, and links to its pull request and to the ticket on the desktop. */
export function ticket(scope: RenderScope, key: string, title: string, op?: string): ImElement[] {
  const { w } = scope;
  const item = op === "deleted" ? null : scope.items?.getByKey(scope.projectId, key);
  const code = item ? codeFields(w, codeOf(scope, item.id)) : { fields: [], links: [] };
  const fields = item ? [
    { label: w("status"), value: statusText(w, item.status) },
    { label: w("priority"), value: named(w, PRIORITY[item.priority], String(item.priority)) },
    ...code.fields
  ] : [];
  const verbWord = op ? OP[op] : undefined;
  const verb = verbWord ? `${w(verbWord)} · ` : "";
  return [
    { type: "section", title: `${verb}${key} ${item?.title ?? title}`, ...(fields.length ? { fields } : {}) },
    ...(op === "deleted" ? [] : [{ type: "links" as const, links: [...code.links, { label: w("openInTomrade"), url: links.item(scope.projectId, key) }] }])
  ];
}

/** What changed in a ticket's code worth telling a conversation that saw the ticket, compared by `codeSeen`. */
export interface CodeSeen { pr: string | null; merged: boolean; blocked: boolean; proposals: string[] }

export function codeSeen(code: CodeSummary): CodeSeen {
  const primary = code.links[0];
  return {
    pr: primary && (primary.prNumber !== null || primary.prUrl) ? `${primary.prNumber ?? primary.prUrl}:${primary.prState ?? ""}` : null,
    merged: !!primary && (primary.prState === "merged" || !!primary.mergedSha),
    blocked: code.session?.blocked === "merge",
    proposals: code.proposals.map(p => p.id)
  };
}

/** The events between two sightings, as the card's headline; empty when nothing new is worth a message. */
export function codeNews(w: ImSpeak, was: CodeSeen, now: CodeSeen, code: CodeSummary): string[] {
  const primary = code.links[0];
  const pr = primary?.prNumber !== null && primary?.prNumber !== undefined ? ` #${primary.prNumber}` : "";
  const news: string[] = [];
  if (now.merged && !was.merged) news.push(w("merged"));
  else if (now.pr !== was.pr && primary?.prState === "open") news.push(w("prOpened", { pr }));
  else if (now.pr !== was.pr && primary?.prState === "closed") news.push(w("prClosedUnmerged", { pr }));
  if (now.blocked && !was.blocked) news.push(w("agentCantMerge"));
  for (const p of code.proposals.filter(p => p.kind === "flag" && !was.proposals.includes(p.id))) news.push(`⚠ ${p.reason}`);
  return news;
}

/** A status change git proposes, worded for the buttons that settle it. */
export function proposalText(w: ImSpeak, key: string, proposal: CodeSummary["proposals"][number]): string {
  const to = proposal.toStatus ? statusText(w, proposal.toStatus) : "";
  return w("proposal", { key, to, reason: proposal.reason });
}

/** The part of a ticket's evidence a delivery card reads. */
export interface Delivered {
  key: string; title: string; status: string;
  evidence: {
    resources: { id: string; name: string; file: { fileId: string } }[];
    submissions: { id: string; report: string; artifactIds: string[] }[];
    reviews: { submissionId: string; decision: string }[];
  };
}

/** How much of a delivery's report the card carries; the rest is on the desktop. */
const REPORT_LIMIT = 1500;

/** The latest submission, while it still waits on the person's verdict. */
export function awaitingReview(item: Delivered) {
  const submission = item.evidence.submissions.at(-1);
  return submission && item.status === "verifying" && !item.evidence.reviews.some(r => r.submissionId === submission.id) ? submission : null;
}

/** How a submission stopped waiting, for its card once the buttons go. */
export function reviewOutcome(w: ImSpeak, item: Delivered, submissionId: string): string {
  const review = item.evidence.reviews.find(r => r.submissionId === submissionId);
  if (review?.decision === "accepted") return w("reviewAccepted");
  if (review) return w("reviewChanges");
  if (item.evidence.submissions.at(-1)?.id !== submissionId) return w("reviewReplaced");
  return w("reviewGone");
}

/** A delivery waiting on the person: its report, its artifacts, and the ticket with its code. */
export function deliveryCard(scope: RenderScope, item: Delivered, submission: Delivered["evidence"]["submissions"][number]): ImContent {
  const { w } = scope;
  const report = submission.report.length > REPORT_LIMIT ? `${submission.report.slice(0, REPORT_LIMIT)}…` : submission.report;
  const artifacts = submission.artifactIds.flatMap(id => item.evidence.resources.filter(r => r.id === id));
  return {
    text: [w("readyForReview", { key: item.key }), report].join("\n\n"),
    elements: [
      ...ticket(scope, item.key, item.title),
      ...(artifacts.length ? [{ type: "section" as const, title: w("artifacts"),
        text: artifacts.map(a => `- [${a.name}](${links.file(scope.projectId, a.file.fileId)})`).join("\n") }] : [])
    ]
  };
}

/** Known card schemas as semantic cards; any other gets its title and a way into the conversation. */
function card(scope: RenderScope, block: Extract<Block, { type: "card" }>): ImContent {
  const { w } = scope;
  const data = (block.data ?? {}) as Record<string, unknown>;
  switch (block.schema) {
    case "start":
      if (typeof data.key === "string") return { text: typeof data.task === "string" && data.task ? w("startTask", { task: data.task }) : "", elements: ticket(scope, data.key, String(data.title ?? "")) };
      break;
    case "backlog.proposal": {
      const epics = Array.isArray(data.epics) ? data.epics as { title?: string; features?: { title?: string }[] }[] : [];
      const text = epics.map(e => [`**${e.title ?? ""}**`, ...(e.features ?? []).map(f => `- ${f.title ?? ""}`)].join("\n")).join("\n");
      return { text: "", elements: [{ type: "section", title: block.title, ...(text ? { text } : {}) }] };
    }
    case "checklist": {
      const rows = Array.isArray(data.rows) ? data.rows as { title: string; state: string; line?: string }[] : [];
      const mark: Record<string, string> = { ok: "✓", warn: "!", fail: "✗", skip: "–", running: "…", pending: "·" };
      return { text: "", elements: [{ type: "section", title: block.title, text: rows.map(r => `${mark[r.state] ?? "·"} ${r.title}${r.line ? ` — ${r.line}` : ""}`).join("\n") }] };
    }
  }
  return { text: "", elements: [{ type: "section", title: block.title },
    { type: "links", links: [{ label: w("seeInTomrade"), url: links.thread(scope.projectId, scope.threadId) }] }] };
}

/** A file the turn saved with write_file, by the version the tool returned. */
export function savedFile(block: Extract<Block, { type: "trace" }>): { path: string; fileId: string; versionId: string; size: number } | null {
  if (block.tool !== "write_file" || !block.ok) return null;
  const ids = /"fileId":"([^"]+)","versionId":"([^"]+)"/.exec(block.summary);
  // The saved path (a ticket's files land in its workstream folder), unless the summary cut it short.
  const saved = /"path":"((?:[^"\\]|\\.)*)"/.exec(block.summary)?.[1];
  const path = saved !== undefined ? JSON.parse(`"${saved}"`) as string : (block.args as { path?: unknown } | null)?.path;
  if (!ids || typeof path !== "string") return null;
  const size = Number(/"size":(\d+)/.exec(block.summary)?.[1] ?? 0);
  return { path, fileId: ids[1], versionId: ids[2], size };
}

const MIME: Record<string, string> = { md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", html: "text/html", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" };

/** An outbound handle for a Files version; `readOutboundFile` resolves it. */
export const FILE_HANDLE = /^files:([^:]+):([^:]+)$/;

/**
 * A stored Agent message as IM content. Tool calls appear only when the route
 * asks for detail, as one line each without arguments or output.
 */
export function renderBlock(scope: RenderScope, block: Block, detail: boolean): ImContent | null {
  const { w } = scope;
  switch (block.type) {
    case "text": return { text: block.text };
    case "error": return { text: w("executionError", { text: block.text }) };
    case "note": return { text: block.text };
    case "changes": {
      const items = block.items ?? [];
      if (!items.length) return { text: w("changedCount", { count: block.count }) };
      const rest = items.length - CARD_LIMIT;
      return { text: rest > 0 ? w("andMore", { n: rest }) : "",
        elements: items.slice(0, CARD_LIMIT).flatMap(i => ticket(scope, i.key, i.label, i.op)) };
    }
    case "media": return { text: block.caption ?? block.media.name, files: [{ id: block.media.id, name: block.media.name, mimeType: block.media.mime, size: block.media.size }] };
    case "card": return card(scope, block);
    case "trace": {
      const file = savedFile(block);
      if (file) {
        const name = file.path.split("/").pop() ?? file.path;
        return { text: w("saved", { path: file.path, url: links.file(scope.projectId, file.fileId) }),
          files: [{ id: `files:${file.fileId}:${file.versionId}`, name, mimeType: MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream", size: file.size }] };
      }
      return detail ? { text: `${block.ok ? "✓" : "✗"} ${block.tool}` } : null;
    }
    default: return null;
  }
}

/** The tools a turn has called, as one line for its progress message. */
export function toolLine(tools: { tool: string; ok: boolean }[]): string {
  if (!tools.length) return "";
  const shown = tools.slice(-6).map(t => `${t.tool} ${t.ok ? "✓" : "✗"}`);
  return `${tools.length > 6 ? `… ` : ""}${shown.join(" · ")}`;
}
