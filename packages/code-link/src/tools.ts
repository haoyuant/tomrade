import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/agent";
import type {} from "@tomrade/boards";
import type {} from "@tomrade/items";
import type { Item } from "@tomrade/domain";
import { defineTool, requireProjectId, type ToolInvocation } from "@tomrade/tools";
import { sessionContext } from "./sessions.js";
import type { CodeLinkStore, CodeLinkView, SessionView } from "./store.js";
import type { PrState } from "./rules.js";

/** What the tools need from the service without importing it. */
export interface ToolHost {
  store: CodeLinkStore;
  /** Re-judge one ticket in one repository after a link changed by hand or by tool. */
  reevaluate(projectId: string, itemId: string, repoId: string): void;
  noteProgress(projectId: string, sessionId: string, text: string): void;
  notify(projectId: string): void;
}

/** The ticket, repository and branch a call is about: named by key, or implied by the session or the run's thread. */
interface Subject {
  item: Item;
  repoId: string | null;
  branch: string | null;
  session: SessionView | null;
}

const PR_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

export function registerTools(ctx: Context, host: ToolHost): void {
  const subject = (tool: string, projectId: string, key: string | undefined, inv: ToolInvocation): Subject => {
    const bound = sessionContext.getStore();
    const session = bound && bound.projectId === projectId ? host.store.session(projectId, bound.sessionId) : null;
    const thread = inv.run ? (ctx.get("agent")?.store.thread(projectId, inv.run.threadId) ?? null) : null;
    const runSession = thread ? (host.store.sessions(projectId, { live: true }).find((s) => s.threadId === thread.id) ?? null) : null;
    const s = session ?? runSession;

    let item: Item | null = null;
    if (key) item = ctx.items.getByKey(projectId, key.toUpperCase());
    else if (s?.itemIds[0]) item = ctx.items.get(projectId, s.itemIds[0]);
    else if (thread?.itemId) item = ctx.items.get(projectId, thread.itemId);
    if (!item) throw new Error(key ? `${tool}: no ticket ${key} in this project` : `${tool}: this session is not on a ticket — pass key`);

    const board = ctx.boards.get(projectId, item.boardId);
    const repoId = s?.repoId ?? board?.repoId ?? null;
    const branch = s?.branch ?? thread?.branch ?? null;
    return { item, repoId, branch, session: s };
  };

  ctx.tools.register(
    defineTool({
      name: "link_code",
      title: "Link code to a ticket",
      description:
        "Attach a branch and/or pull request to a ticket. Call it when you push and open a PR (pass prUrl); the ticket moves to Verifying. Without `key` it applies to the ticket this session was started from.",
      input: z.object({
        key: z.string().optional().describe("Ticket key, e.g. TOM-42; defaults to this session's ticket"),
        branch: z.string().optional().describe("Branch name; defaults to this session's branch"),
        prUrl: z.string().url().optional(),
        prNumber: z.number().int().positive().optional(),
        prState: z.enum(["open", "merged", "closed"]).optional().describe("Defaults to open when a prUrl is given"),
        projectId: z.string().optional()
      }),
      execute: (args, inv) => {
        const projectId = requireProjectId("link_code", args.projectId, inv);
        const { item, repoId, branch: implied } = subject("link_code", projectId, args.key, inv);
        if (!repoId) throw new Error(`link_code: ${item.key}'s workstream has no repository`);
        const existing = host.store.links(projectId, item.id).filter((l) => l.repoId === repoId && l.branch);
        const branch = args.branch?.replace(/^origin\//, "") ?? implied ?? existing[0]?.branch ?? "";
        if (!branch) throw new Error("link_code: pass branch — this session has none");
        const prNumber = args.prNumber ?? (args.prUrl ? Number(PR_NUMBER.exec(args.prUrl)?.[1]) || null : null);
        const prState: PrState | null = args.prState ?? (args.prUrl ? "open" : null);
        const link: CodeLinkView = host.store.upsertLink(
          projectId,
          { itemId: item.id, repoId, branch },
          {
            ...(args.prUrl ? { prUrl: args.prUrl } : {}),
            ...(prNumber ? { prNumber } : {}),
            ...(prState ? { prState } : {}),
            ...(inv.run ? { threadId: inv.run.threadId } : {}),
            source: "mcp",
            lastSeenAt: Date.now()
          }
        );
        host.reevaluate(projectId, item.id, repoId);
        const after = ctx.items.get(projectId, item.id)!;
        return { key: after.key, status: after.status, branch: link.branch, prUrl: link.prUrl, prState: link.prState };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "note_progress",
      title: "Note progress on the ticket",
      description: "One line about where the work stands (\"tests green, wiring the API next\"). Shown on the ticket while the session runs. Applies to this session's ticket unless `key` is given.",
      input: z.object({ text: z.string().min(1).max(280), key: z.string().optional(), projectId: z.string().optional() }),
      execute: (args, inv) => {
        const projectId = requireProjectId("note_progress", args.projectId, inv);
        const { item, session } = subject("note_progress", projectId, args.key, inv);
        if (!session) throw new Error(`note_progress: no live coding session on ${item.key}`);
        host.noteProgress(projectId, session.id, args.text.trim());
        return { ok: true, key: item.key };
      }
    })
  );
}
