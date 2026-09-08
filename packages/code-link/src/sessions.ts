import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type {} from "@tomrade/mcp";
import type {} from "@tomrade/tools";
import type { Author } from "@tomrade/domain";
import type { CodeLinkStore, SessionState, SessionView } from "./store.js";

/** How long a session may be silent before it counts as idle, and how long idle before it is over. */
export const IDLE_AFTER_MS = 10 * 60 * 1000;
export const END_AFTER_MS = 60 * 60 * 1000;

/** The coding session a tool call belongs to, when it came in over a session's MCP token. */
export const sessionContext = new AsyncLocalStorage<{ projectId: string; sessionId: string }>();

/** What Claude Code's hooks post: the event name is what matters; the session id is a bonus. */
interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
}

/** The Claude Code hook events a session listens to, and what each says about it. */
const HOOK_STATES: Record<string, SessionState | "touch"> = {
  SessionStart: "running",
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  SubagentStop: "touch",
  Notification: "waiting",
  Stop: "waiting",
  SessionEnd: "ended"
};

export interface SessionFiles {
  dir: string;
  mcpConfig: string;
  settings: string;
  prompt: string;
  mcpUrl: string;
  eventUrl: string;
  token: string;
}

/**
 * A coding agent's session as Tomrade follows it: a token that binds its MCP
 * calls and hook events to one ticket, and a state read from those signals.
 * Nothing here owns the process — the session may be a terminal the user has
 * open — so liveness is inferred, and a quiet session ends by the clock.
 */
export class Sessions {
  private readonly live = new Map<string, { token: string; unbind: () => void }>();

  constructor(
    private readonly ctx: Context,
    private readonly store: CodeLinkStore,
    private readonly onChange: (projectId: string) => void
  ) {}

  /** Bind a token for the session and lay down the files its agent starts from. Null when the MCP server is not running. */
  bind(session: SessionView, author: Author, dir: string, prompt: string): SessionFiles | null {
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) return null;
    const existing = this.live.get(session.id);
    if (existing) existing.unbind();
    const token = randomUUID();
    const unbind = mcp.bindRun(token, {
      author,
      projectId: session.projectId,
      execute: (name, args) => {
        this.touch(session.projectId, session.id, { state: "running", tool: true });
        return sessionContext.run({ projectId: session.projectId, sessionId: session.id }, () => this.ctx.tools.execute(name, args, { by: author, projectId: session.projectId }));
      },
      event: (payload) => this.event(session.projectId, session.id, payload)
    });
    this.live.set(session.id, { token, unbind });

    const mcpUrl = mcp.urlFor(session.projectId)!;
    const eventUrl = mcp.eventUrlFor(token)!;
    fs.mkdirSync(dir, { recursive: true });
    const mcpConfig = path.join(dir, "mcp.json");
    const settings = path.join(dir, "settings.json");
    const promptFile = path.join(dir, "prompt.md");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tomrade: { type: "http", url: mcpUrl, headers: { "X-Tomrade-Run": token } } } }, null, 2));
    fs.writeFileSync(settings, JSON.stringify(hooksSettings(eventUrl), null, 2));
    fs.writeFileSync(promptFile, prompt);
    return { dir, mcpConfig, settings, prompt: promptFile, mcpUrl, eventUrl, token };
  }

  token(sessionId: string): string | null {
    return this.live.get(sessionId)?.token ?? null;
  }

  release(sessionId: string): void {
    const bound = this.live.get(sessionId);
    if (!bound) return;
    bound.unbind();
    this.live.delete(sessionId);
  }

  /** A hook fired in the agent's process. */
  event(projectId: string, sessionId: string, payload: unknown): void {
    const p = (payload ?? {}) as HookPayload;
    const state = p.hook_event_name ? HOOK_STATES[p.hook_event_name] : undefined;
    const patch: { state?: SessionState; externalId?: string; endedAt?: number } = {};
    if (state && state !== "touch") patch.state = state;
    if (typeof p.session_id === "string" && p.session_id) patch.externalId = p.session_id;
    if (state === "ended") patch.endedAt = Date.now();
    this.touch(projectId, sessionId, patch);
    if (state === "ended") this.release(sessionId);
  }

  /** Any sign of life, with what it says about the session. */
  touch(projectId: string, sessionId: string, patch: { state?: SessionState; externalId?: string; endedAt?: number; tool?: boolean; summary?: string } = {}): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    const now = Date.now();
    // An ended session stays ended; a late hook does not resurrect it.
    const state = session.state === "ended" && patch.state !== "ended" ? undefined : patch.state;
    this.store.patchSession(projectId, sessionId, {
      lastEventAt: now,
      ...(patch.tool ? { lastToolAt: now } : {}),
      ...(state ? { state } : {}),
      ...(patch.externalId ? { externalId: patch.externalId } : {}),
      ...(patch.endedAt ? { endedAt: patch.endedAt } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {})
    });
    this.onChange(projectId);
  }

  end(projectId: string, sessionId: string, state: "ended" | "lost" = "ended"): void {
    const session = this.store.session(projectId, sessionId);
    if (!session || session.state === "ended") return;
    this.store.patchSession(projectId, sessionId, { state, endedAt: Date.now() });
    this.release(sessionId);
    this.onChange(projectId);
  }

  /** The clock's verdict on quiet sessions: idle after a while, over after a long while. */
  sweep(projectId: string, now = Date.now()): void {
    let changed = false;
    for (const s of this.store.sessions(projectId, { live: true })) {
      const quiet = now - (s.lastEventAt ?? s.startedAt);
      if (s.state === "lost") continue;
      if ((s.state === "running" || s.state === "waiting") && quiet >= IDLE_AFTER_MS) {
        this.store.patchSession(projectId, s.id, { state: "idle" });
        changed = true;
      } else if (s.state === "idle" && s.mode === "terminal" && quiet >= END_AFTER_MS) {
        this.store.patchSession(projectId, s.id, { state: "ended", endedAt: now });
        this.release(s.id);
        changed = true;
      }
    }
    if (changed) this.onChange(projectId);
  }

  /** After a restart no headless process is left; the row says so, and the ticket still offers Continue. */
  reconcile(projectId: string): void {
    let changed = false;
    for (const s of this.store.sessions(projectId, { live: true })) {
      if (s.mode !== "headless" || s.state === "lost") continue;
      this.store.patchSession(projectId, s.id, { state: "lost" });
      changed = true;
    }
    if (changed) this.onChange(projectId);
  }
}

/** Claude Code settings that make every lifecycle event a POST to Tomrade. Loaded with `--settings`, so the repository is left alone. */
export function hooksSettings(eventUrl: string): Record<string, unknown> {
  const post = { type: "command", command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${eventUrl}' >/dev/null 2>&1 || true` };
  const hooks: Record<string, unknown> = {};
  for (const event of Object.keys(HOOK_STATES)) hooks[event] = [{ hooks: [post] }];
  return { hooks };
}
