import type { Block } from "@tomradex/agent";
import type { ImContent, ImElement } from "@tomradex/plugin-sdk";
import type { Say } from "./render.js";

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

export interface RenderScope { projectId: string; threadId: string; say: Say; items?: ItemLookup; code?: CodeLookup }

/** How many changed tickets get a card each; the rest are counted. */
const CARD_LIMIT = 8;

const STATUS: Record<string, [string, string]> = {
  backlog: ["Backlog", "待规划"], todo: ["Todo", "待办"], doing: ["Doing", "进行中"],
  verifying: ["Verifying", "待验收"], done: ["Done", "已完成"], cancelled: ["Cancelled", "已取消"]
};
const PRIORITY: [string, string][] = [["None", "无"], ["Low", "低"], ["Medium", "中"], ["High", "高"], ["Urgent", "紧急"]];
const OP: Record<string, [string, string]> = { created: ["Created", "已创建"], updated: ["Updated", "已更新"], deleted: ["Deleted", "已删除"] };

const PR_STATE: Record<string, [string, string]> = { open: ["Open", "进行中"], merged: ["Merged", "已合并"], closed: ["Closed", "已关闭"] };
const SESSION: Record<string, [string, string]> = {
  running: ["Running", "运行中"], waiting: ["Waiting for you", "等你处理"], idle: ["Idle", "空闲"], error: ["Stopped", "已停止"], lost: ["Lost", "已失联"]
};

/** The code a card shows. Code link is optional: without it, or when it fails, the card is the ticket alone. */
function codeOf(scope: RenderScope, itemId: string): CodeSummary | null {
  try { return scope.code?.summary(scope.projectId, itemId) ?? null; } catch { return null; }
}

/** The primary branch and pull request, and the session at work, as card fields; the pull request's page as a link. */
export function codeFields(say: Say, code: CodeSummary | null): { fields: { label: string; value: string }[]; links: { label: string; url: string }[] } {
  const primary = code?.links[0];
  const fields: { label: string; value: string }[] = [];
  const urls: { label: string; url: string }[] = [];
  if (primary?.branch) fields.push({ label: say("Branch", "分支"), value: primary.branch });
  if (primary && (primary.prNumber !== null || primary.prUrl)) {
    const state = primary.prState ? say(...PR_STATE[primary.prState]) : "";
    fields.push({ label: say("Pull request", "PR"), value: [primary.prNumber !== null ? `#${primary.prNumber}` : "", state].filter(Boolean).join(" · ") });
    if (primary.prUrl && /^https?:\/\//.test(primary.prUrl)) urls.push({ label: primary.prNumber !== null ? say(`Pull request #${primary.prNumber}`, `PR #${primary.prNumber}`) : say("Pull request", "PR"), url: primary.prUrl });
  } else if (primary?.mergedSha) fields.push({ label: say("Merged", "已合并"), value: primary.mergedSha.slice(0, 7) });
  const session = code?.session;
  if (session && SESSION[session.state]) fields.push({ label: say("Session", "编码会话"), value: session.blocked === "merge" ? say("Merge waits on you", "等你合并") : say(...SESSION[session.state]) });
  return { fields, links: urls };
}

/** A ticket as a card: key and title, its state and code, and links to its pull request and to the ticket on the desktop. */
export function ticket(scope: RenderScope, key: string, title: string, op?: string): ImElement[] {
  const { say } = scope;
  const item = op === "deleted" ? null : scope.items?.getByKey(scope.projectId, key);
  const code = item ? codeFields(say, codeOf(scope, item.id)) : { fields: [], links: [] };
  const fields = item ? [
    { label: say("Status", "状态"), value: say(...(STATUS[item.status] ?? [item.status, item.status])) },
    { label: say("Priority", "优先级"), value: say(...(PRIORITY[item.priority] ?? [String(item.priority), String(item.priority)])) },
    ...code.fields
  ] : [];
  const verb = op && OP[op] ? `${say(...OP[op])} · ` : "";
  return [
    { type: "section", title: `${verb}${key} ${item?.title ?? title}`, ...(fields.length ? { fields } : {}) },
    ...(op === "deleted" ? [] : [{ type: "links" as const, links: [...code.links, { label: say("Open in Tomrade", "在 Tomrade 打开"), url: links.item(scope.projectId, key) }] }])
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
export function codeNews(say: Say, was: CodeSeen, now: CodeSeen, code: CodeSummary): string[] {
  const primary = code.links[0];
  const pr = primary?.prNumber !== null && primary?.prNumber !== undefined ? ` #${primary.prNumber}` : "";
  const news: string[] = [];
  if (now.merged && !was.merged) news.push(say("Merged", "已合并"));
  else if (now.pr !== was.pr && primary?.prState === "open") news.push(say(`Pull request${pr} opened`, `已开 PR${pr}`));
  else if (now.pr !== was.pr && primary?.prState === "closed") news.push(say(`Pull request${pr} closed without merging`, `PR${pr} 已关闭，未合并`));
  if (now.blocked && !was.blocked) news.push(say("The agent couldn't merge; the merge waits on you", "agent 无法合并，需要你来合并"));
  for (const p of code.proposals.filter(p => p.kind === "flag" && !was.proposals.includes(p.id))) news.push(`⚠ ${p.reason}`);
  return news;
}

/** A status change git proposes, worded for the buttons that settle it. */
export function proposalText(say: Say, key: string, proposal: CodeSummary["proposals"][number]): string {
  const to = proposal.toStatus ? say(...(STATUS[proposal.toStatus] ?? [proposal.toStatus, proposal.toStatus])) : "";
  return say(`${key}: move it to ${to}?\n${proposal.reason}`, `${key}：改为「${to}」吗？\n${proposal.reason}`);
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
export function reviewOutcome(say: Say, item: Delivered, submissionId: string): string {
  const review = item.evidence.reviews.find(r => r.submissionId === submissionId);
  if (review?.decision === "accepted") return say("Accepted", "已验收通过");
  if (review) return say("Sent back for changes", "已退回修改");
  if (item.evidence.submissions.at(-1)?.id !== submissionId) return say("A newer delivery replaced it", "已有更新的交付");
  return say("No longer waiting for review", "已不再等待验收");
}

/** A delivery waiting on the person: its report, its artifacts, and the ticket with its code. */
export function deliveryCard(scope: RenderScope, item: Delivered, submission: Delivered["evidence"]["submissions"][number]): ImContent {
  const { say } = scope;
  const report = submission.report.length > REPORT_LIMIT ? `${submission.report.slice(0, REPORT_LIMIT)}…` : submission.report;
  const artifacts = submission.artifactIds.flatMap(id => item.evidence.resources.filter(r => r.id === id));
  return {
    text: [say(`${item.key} is ready for your review`, `${item.key} 已提交交付，等你验收`), report].join("\n\n"),
    elements: [
      ...ticket(scope, item.key, item.title),
      ...(artifacts.length ? [{ type: "section" as const, title: say("Artifacts", "产物"),
        text: artifacts.map(a => `- [${a.name}](${links.file(scope.projectId, a.file.fileId)})`).join("\n") }] : [])
    ]
  };
}

/** Known card schemas as semantic cards; any other gets its title and a way into the conversation. */
function card(scope: RenderScope, block: Extract<Block, { type: "card" }>): ImContent {
  const { say } = scope;
  const data = (block.data ?? {}) as Record<string, unknown>;
  switch (block.schema) {
    case "start":
      if (typeof data.key === "string") return { text: "", elements: ticket(scope, data.key, String(data.title ?? "")) };
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
    { type: "links", links: [{ label: say("See it in Tomrade", "在 Tomrade 查看"), url: links.thread(scope.projectId, scope.threadId) }] }] };
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
  const { say } = scope;
  switch (block.type) {
    case "text": return { text: block.text };
    case "error": return { text: say(`Execution error: ${block.text}`, `执行出错：${block.text}`) };
    case "note": return { text: block.text };
    case "changes": {
      const items = block.items ?? [];
      if (!items.length) return { text: say(`Changed ${block.count} items`, `已变更 ${block.count} 项`) };
      const rest = items.length - CARD_LIMIT;
      return { text: rest > 0 ? say(`…and ${rest} more`, `……另有 ${rest} 项`) : "",
        elements: items.slice(0, CARD_LIMIT).flatMap(i => ticket(scope, i.key, i.label, i.op)) };
    }
    case "media": return { text: block.caption ?? block.media.name, files: [{ id: block.media.id, name: block.media.name, mimeType: block.media.mime, size: block.media.size }] };
    case "card": return card(scope, block);
    case "trace": {
      const file = savedFile(block);
      if (file) {
        const name = file.path.split("/").pop() ?? file.path;
        return { text: say(`Saved [${file.path}](${links.file(scope.projectId, file.fileId)})`, `已保存 [${file.path}](${links.file(scope.projectId, file.fileId)})`),
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
