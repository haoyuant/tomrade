import fs from "node:fs";
import path from "node:path";
import type { CliHandler } from "@tomradex/mcp";
import { parseBranch } from "./keys.js";
import { branchAt } from "./sessions.js";
import type { SessionView } from "./store.js";
import type { CodeWords } from "./words.js";

/** What `tomrade claim|note|link|create|list|show` reaches of Tomrade: the same tools its MCP server serves. */
export interface TicketCliDeps {
  projectIds(): string[];
  foldersOf(projectId: string): string[];
  prefixOf(projectId: string): string;
  /** Live sessions on the ticket. */
  sessionsOn(projectId: string, itemId: string): SessionView[];
  itemId(projectId: string, key: string): string | null;
  /** The command's calls on this ticket mean this session, as an MCP connection's would. */
  bind(projectId: string, connection: string, sessionId: string): void;
  call(name: string, args: Record<string, unknown>, opts: { token?: string; projectId?: string; connection?: string }): Promise<unknown>;
  words(): CodeWords;
}

/** What the command prints: `text` by default, `result` (the tool's own answer) with --json. */
export interface TicketAnswer {
  ok: boolean;
  text: string;
  result?: unknown;
}

const real = (dir: string): string[] => {
  const resolved = path.resolve(dir);
  try {
    const actual = fs.realpathSync(resolved);
    return actual === resolved ? [resolved] : [resolved, actual];
  } catch {
    return [resolved];
  }
};

const within = (dir: string, root: string): boolean => {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The checkout a folder's git worktree belongs to, read from .git without running git; null outside git. */
export function checkoutOf(dir: string): string | null {
  try {
    for (let at = path.resolve(dir); ; ) {
      const dotGit = path.join(at, ".git");
      if (fs.existsSync(dotGit)) {
        if (fs.statSync(dotGit).isDirectory()) return at;
        const gitDir = path.resolve(at, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
        const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
        return path.basename(common) === ".git" ? path.dirname(common) : null;
      }
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  } catch {
    return null;
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function serveTicketCli(deps: TicketCliDeps): CliHandler {
  /** The project whose repository holds the folder (its checkout or a worktree of it); the deepest match wins. */
  const projectAt = (cwd: string): string | null => {
    const checkout = checkoutOf(cwd);
    const places = [...real(cwd), ...(checkout ? real(checkout) : [])];
    let best: { id: string; depth: number } | null = null;
    for (const id of deps.projectIds()) {
      for (const root of deps.foldersOf(id).flatMap(real)) {
        if (places.some((p) => within(p, root)) && (!best || root.length > best.depth)) best = { id, depth: root.length };
      }
    }
    if (best) return best.id;
    const ids = deps.projectIds();
    return ids.length === 1 ? ids[0]! : null;
  };

  /** The key named, else the one the folder's branch carries. */
  const keyAt = (projectId: string, named: string | undefined, cwd: string): string | null => {
    if (named) return named.toUpperCase();
    const branch = branchAt(cwd);
    const prefix = deps.prefixOf(projectId);
    const n = branch ? parseBranch(branch, prefix) : null;
    return n === null ? null : `${prefix}-${n}`;
  };

  /** The outside session that claimed the ticket: the command speaks for it as its MCP connection would, so the same guards apply. */
  const connectionFor = (projectId: string, key: string): string | undefined => {
    const itemId = deps.itemId(projectId, key);
    const session = itemId ? deps.sessionsOn(projectId, itemId).find((s) => s.threadId === null && s.mode === "terminal" && s.state !== "lost" && s.endedAt === null) : undefined;
    if (!session) return undefined;
    const connection = `cli:${session.id}`;
    deps.bind(projectId, connection, session.id);
    return connection;
  };

  return async (request): Promise<TicketAnswer> => {
    const w = deps.words();
    const op = str(request.op) ?? "";
    const cwd = str(request.cwd) ?? process.cwd();
    const token = str(request.token);
    // A session Tomrade started carries its project and ticket in its token; any other is placed by its folder.
    const projectId = projectAt(cwd) ?? undefined;
    if (!token && !projectId) return { ok: false, text: w("cliNoProject") };
    const scoped = { ...(token ? { token } : {}), ...(projectId ? { projectId } : {}) };
    const call = (name: string, args: Record<string, unknown>, connection?: string) => deps.call(name, args, { ...scoped, ...(connection ? { connection } : {}) });
    /** For note and link: the ticket by key, or the token's own; with a key, as the session that claimed it. */
    const ticketCall = async (name: string, args: Record<string, unknown>) => {
      if (token) return call(name, { ...args, ...(str(request.key) ? { key: str(request.key) } : {}) });
      const key = keyAt(projectId!, str(request.key), cwd);
      if (!key) return null;
      return call(name, { ...args, key }, connectionFor(projectId!, key));
    };
    try {
      switch (op) {
        case "claim": {
          const key = str(request.key);
          if (!key) return { ok: false, text: w("cliNoKey") };
          const result = (await call("claim_ticket", { key, ...(request.parallel === true ? { parallel: true } : {}) })) as Record<string, unknown>;
          return { ok: result.claimed !== false, text: claimText(result, w), result };
        }
        case "note": {
          const text = str(request.text);
          if (!text) return { ok: false, text: w("cliNoText") };
          const result = (await ticketCall("note_progress", { text })) as Record<string, unknown> | null;
          if (!result) return { ok: false, text: w("cliNoKey") };
          return { ok: result.ok !== false, text: result.ok === false ? String(result.warning ?? "") : w("cliNoted", { key: String(result.key) }), result };
        }
        case "link": {
          const branch = str(request.branch) ?? (token ? undefined : (branchAt(cwd) ?? undefined));
          const args = { ...(branch ? { branch } : {}), ...(str(request.pr) ? { prUrl: str(request.pr) } : {}), ...(request.scopeChecked === true ? { scopeChecked: true } : {}) };
          const result = (await ticketCall("link_code", args)) as Record<string, unknown> | null;
          if (!result) return { ok: false, text: w("cliNoKey") };
          const said = w("cliLinked", { key: String(result.key), branch: String(result.branch ?? ""), status: String(result.status ?? "") });
          return { ok: true, text: [said, result.prUrl ? String(result.prUrl) : null, result.warning ? String(result.warning) : null].filter(Boolean).join("\n"), result };
        }
        case "create": {
          const title = str(request.title);
          if (!title) return { ok: false, text: w("cliNoTitle") };
          const result = (await call("create_item", { title, ...(str(request.body) ? { body: str(request.body) } : {}) })) as Record<string, unknown>;
          return { ok: true, text: w("cliCreated", { key: String(result.key), title: String(result.title) }), result };
        }
        case "list": {
          const limit = typeof request.limit === "number" && request.limit > 0 ? Math.floor(request.limit) : undefined;
          const result = await call("list_items", { ...(str(request.search) ? { search: str(request.search) } : {}), ...(str(request.status) ? { status: str(request.status) } : {}), ...(limit ? { limit } : {}) });
          const rows = rowsOf(result);
          return { ok: true, text: rows.length ? rows.map((r) => `${r.key}  ${r.status}  ${r.title}`).join("\n") : w("cliNoneFound"), result };
        }
        case "show": {
          const key = str(request.key);
          if (!key) return { ok: false, text: w("cliNoKey") };
          const result = (await call("get_item", { id: key.toUpperCase() })) as Record<string, unknown> | null;
          if (!result) return { ok: false, text: w("cliNoTicket", { key: key.toUpperCase() }), result };
          const head = `${result.key}  ${result.status}  ${result.title}`;
          return { ok: true, text: typeof result.body === "string" && result.body.trim() ? `${head}\n\n${result.body.trim()}` : head, result };
        }
        default:
          return { ok: false, text: w("cliUnknownOp", { op }) };
      }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** The rows of list_items, whether it answered with a list or a page of one. */
function rowsOf(result: unknown): { key: string; status: string; title: string }[] {
  const list = Array.isArray(result) ? result : Array.isArray((result as { items?: unknown } | null)?.items) ? (result as { items: unknown[] }).items : [];
  return list.flatMap((row) => {
    const r = row as { key?: unknown; status?: unknown; title?: unknown };
    return typeof r.key === "string" ? [{ key: r.key, status: String(r.status ?? ""), title: String(r.title ?? "") }] : [];
  });
}

/** A claim as the agent reads it: the ticket and branch, the conventions it returned, and whether Tomrade follows this session. */
function claimText(result: Record<string, unknown>, w: CodeWords): string {
  if (result.claimed === false) return String(result.next ?? "");
  const lines = [w("cliClaimed", { key: String(result.key), title: String(result.title), status: String(result.status ?? ""), branch: String(result.branch ?? "") })];
  const conventions = Array.isArray(result.conventions) ? result.conventions.map(String) : [];
  lines.push(...conventions.map((c) => `- ${c}`));
  const tracking = result.tracking as { tracked?: boolean; message?: unknown } | undefined;
  if (tracking && tracking.tracked === false) lines.push("", typeof tracking.message === "string" ? tracking.message : w("untrackedSession"));
  return lines.join("\n");
}
