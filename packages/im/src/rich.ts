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
export interface ItemLookup { getByKey(projectId: string, key: string): { key: string; title: string; status: string; priority: number } | null }

export interface RenderScope { projectId: string; threadId: string; say: Say; items?: ItemLookup }

/** How many changed tickets get a card each; the rest are counted. */
const CARD_LIMIT = 8;

const STATUS: Record<string, [string, string]> = {
  backlog: ["Backlog", "待规划"], todo: ["Todo", "待办"], doing: ["Doing", "进行中"],
  verifying: ["Verifying", "待验收"], done: ["Done", "已完成"], cancelled: ["Cancelled", "已取消"]
};
const PRIORITY: [string, string][] = [["None", "无"], ["Low", "低"], ["Medium", "中"], ["High", "高"], ["Urgent", "紧急"]];
const OP: Record<string, [string, string]> = { created: ["Created", "已创建"], updated: ["Updated", "已更新"], deleted: ["Deleted", "已删除"] };

/** A ticket as a card: key and title, its state, and a link that opens it on the desktop. */
function ticket(scope: RenderScope, key: string, title: string, op?: string): ImElement[] {
  const { say } = scope;
  const item = op === "deleted" ? null : scope.items?.getByKey(scope.projectId, key);
  const fields = item ? [
    { label: say("Status", "状态"), value: say(...(STATUS[item.status] ?? [item.status, item.status])) },
    { label: say("Priority", "优先级"), value: say(...(PRIORITY[item.priority] ?? [String(item.priority), String(item.priority)])) }
  ] : [];
  const verb = op && OP[op] ? `${say(...OP[op])} · ` : "";
  return [
    { type: "section", title: `${verb}${key} ${item?.title ?? title}`, ...(fields.length ? { fields } : {}) },
    ...(op === "deleted" ? [] : [{ type: "links" as const, links: [{ label: say("Open in Tomrade", "在 Tomrade 打开"), url: links.item(scope.projectId, key) }] }])
  ];
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
