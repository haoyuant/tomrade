import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type {} from "@tomrade/mcp";
import type {} from "@tomrade/tools";
import type { Author } from "@tomrade/domain";
import { classifyRemoteFailure, remoteFailureDetail } from "./remote.js";
import type { CodeLinkStore, SessionState, SessionView } from "./store.js";

/** How long a session may be silent before it counts as idle, and how long idle before it is over. */
export const IDLE_AFTER_MS = 10 * 60 * 1000;
export const END_AFTER_MS = 60 * 60 * 1000;

/** The coding session a tool call belongs to, when it came in over a session's MCP token. */
export const sessionContext = new AsyncLocalStorage<{ projectId: string; sessionId: string }>();

/** What Claude Code's hooks post. Only the fields read here; the rest of the payload is the agent's business. */
interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_error?: string;
  tool_output?: unknown;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  error_type?: string;
  error_message?: string;
  reason?: string;
}

/**
 * The Claude Code hook events a session listens to. Each says something about
 * the session; the ones that say nothing new still count as a sign of life.
 * `Stop` does not fire on a user interrupt — the process check covers that end.
 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "SubagentStop", "SessionEnd"] as const;

/** A moment worth a line in the ticket's thread, as the session's owner reports it. */
export interface SessionMoment {
  kind: "said" | "failed" | "ended";
  text: string;
}

export interface SessionsOptions {
  /** Where a session's files (mcp.json, settings.json, pid) live. */
  dirOf(sessionId: string): string;
  onChange(projectId: string): void;
  /** Something the thread should hear about: what the agent said when it stopped, why it failed, that it ended. */
  onMoment?(session: SessionView, moment: SessionMoment): void;
}

export interface SessionFiles {
  dir: string;
  mcpConfig: string;
  settings: string;
  prompt: string;
  mcpUrl: string;
  eventUrl: string;
  token: string;
}

/** What a tool call is doing, for the ticket: the tool, and the one argument a person recognises it by. */
export function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const v = input?.[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const detail = name === "Bash" ? pick("command") : name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit" ? path.basename(pick("file_path", "path")) : name === "Grep" || name === "Glob" ? pick("pattern") : name === "Task" || name === "Agent" ? pick("description") : pick("description", "query", "url");
  const clipped = detail.replace(/\s+/g, " ").slice(0, 60) + (detail.length > 60 ? "…" : "");
  return clipped ? `${name} · ${clipped}` : name;
}

const firstLine = (text: string | undefined, max: number): string => {
  const t = (text ?? "").trim();
  if (!t) return "";
  const line = t.split("\n").find((l) => l.trim()) ?? t;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

const REMOTE_COMMAND = /\bgit\s+(?:push|fetch|pull|ls-remote|clone)\b|^\s*gh\s/;
const BLOCKED_COMMAND = /\bgit\s+(?:push|fetch|pull)\b|^\s*gh\s/;

const bashCommand = (p: HookPayload): string => (p.tool_name === "Bash" && typeof p.tool_input?.command === "string" ? p.tool_input.command : "");

const outputText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return String(output ?? "");
  const value = output as Record<string, unknown>;
  const text = [value.stderr, value.stdout, value.output, value.content].filter((part): part is string => typeof part === "string").join("\n");
  return text || JSON.stringify(output);
};

const showsNonzeroExit = (output: unknown): boolean => {
  if (output && typeof output === "object") {
    const value = output as Record<string, unknown>;
    for (const key of ["exit_code", "exitCode", "code", "status"]) {
      const code = value[key];
      if ((typeof code === "number" && code !== 0) || (typeof code === "string" && /^[1-9]\d*$/.test(code))) return true;
    }
  }
  return /\b(?:exit(?:ed)?(?: with)?(?: code| status)?|code)\s*[:=]?\s*[1-9]\d*\b/i.test(outputText(output));
};

export const credentialStopText = (detail: string): string =>
  `Tomrade: origin is not reachable from this worktree with the credentials git has here (${detail}). Credentials are the human's to fix — do not switch accounts, edit credential helpers, or change the remote. Commit your work locally, call note_progress with one line starting 'blocked: push', and stop.`;

/**
 * A coding agent's session as Tomrade follows it: a token that binds its MCP
 * calls and hook events to one ticket, and a state read from those signals —
 * plus the process itself, when Tomrade launched it, because a hook can only
 * report what the agent lived to report. Nothing here owns the process.
 */
export class Sessions {
  private readonly live = new Map<string, { token: string; unbind: () => void }>();

  constructor(
    private readonly ctx: Context,
    private readonly store: CodeLinkStore,
    private readonly options: SessionsOptions
  ) {}

  /** What a session's token does when it is used: attribute the call, note the sign of life, hear the hooks. */
  private binding(session: SessionView, author: Author) {
    // Cordis service access through `ctx.tools` is scoped to the synchronous
    // inject callback. MCP invokes this function later, after that scope has
    // gone, so retain the concrete service while the binding is created.
    const tools = this.ctx.get("tools");
    if (!tools) throw new Error("the tools plugin is not loaded");
    return {
      author,
      projectId: session.projectId,
      execute: (name: string, args: unknown) => {
        this.touch(session.projectId, session.id, { state: "running", tool: true });
        return sessionContext.run({ projectId: session.projectId, sessionId: session.id }, () => tools.execute(name, args, { by: author, projectId: session.projectId }));
      },
      event: (payload: unknown) => this.event(session.projectId, session.id, payload)
    };
  }

  /** Bind a token for the session and lay down the files its agent starts from. Null when the MCP server is not running. */
  bind(session: SessionView, author: Author, dir: string, prompt: string): SessionFiles | null {
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) return null;
    const existing = this.live.get(session.id);
    if (existing) existing.unbind();
    const token = randomUUID();
    const unbind = mcp.bindRun(token, this.binding(session, author));
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
    fs.rmSync(path.join(dir, "pid"), { force: true });
    return { dir, mcpConfig, settings, prompt: promptFile, mcpUrl, eventUrl, token };
  }

  token(sessionId: string): string | null {
    return this.live.get(sessionId)?.token ?? null;
  }

  /**
   * After Tomrade restarts, a terminal the user still has open goes on calling
   * with the token it was given. The token is in the session's own mcp.json;
   * read it back and bind it again, so the calls and the hooks land where they did.
   */
  rebind(session: SessionView, author: Author, dir: string): boolean {
    if (this.live.has(session.id)) return true;
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) return false;
    let token: string | null = null;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { mcpServers?: { tomrade?: { headers?: Record<string, string> } } };
      token = config.mcpServers?.tomrade?.headers?.["X-Tomrade-Run"] ?? null;
    } catch {
      return false;
    }
    if (!token) return false;
    this.live.set(session.id, { token, unbind: mcp.bindRun(token, this.binding(session, author)) });
    return true;
  }

  release(sessionId: string): void {
    const bound = this.live.get(sessionId);
    if (!bound) return;
    bound.unbind();
    this.live.delete(sessionId);
  }

  /** A remote authentication failure is a human-owned stop, whether a hook or a headless run reported it. */
  blockCredentials(projectId: string, sessionId: string, errorText: string, patch: { externalId?: string; tool?: boolean } = {}): Record<string, unknown> {
    const session = this.store.session(projectId, sessionId);
    if (!session) return {};
    const detail = remoteFailureDetail(errorText) ?? "credential failure";
    const summary = `cannot reach origin from this worktree: ${detail}`;
    this.touch(projectId, sessionId, { ...patch, state: "error", summary, activity: null, blocked: "credentials" });
    this.options.onMoment?.(this.store.session(projectId, sessionId) ?? session, { kind: "failed", text: summary });
    return { additionalContext: credentialStopText(detail) };
  }

  /** A hook fired in the agent's process: what it says about the session, and what the thread should hear. */
  event(projectId: string, sessionId: string, payload: unknown): Record<string, unknown> {
    const p = (payload ?? {}) as HookPayload;
    const session = this.store.session(projectId, sessionId);
    if (!session) return {};
    const patch: Parameters<Sessions["touch"]>[2] = {};
    if (typeof p.session_id === "string" && p.session_id) patch.externalId = p.session_id;
    const command = bashCommand(p);
    if (p.hook_event_name === "PreToolUse" && session.blocked === "credentials" && BLOCKED_COMMAND.test(command)) {
      this.touch(projectId, sessionId, { ...patch, state: "error", activity: null });
      const detail = session.summary?.replace(/^cannot reach origin from this worktree:\s*/, "") || "credential failure";
      return { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: credentialStopText(detail) } };
    }
    const failedOutput = p.hook_event_name === "PostToolUseFailure" ? p.tool_error ?? "" : p.hook_event_name === "PostToolUse" && showsNonzeroExit(p.tool_output) ? outputText(p.tool_output) : "";
    if (command && REMOTE_COMMAND.test(command) && classifyRemoteFailure(failedOutput) === "credentials") {
      return this.blockCredentials(projectId, sessionId, failedOutput, { ...(patch.externalId ? { externalId: patch.externalId } : {}), tool: true });
    }
    let moment: SessionMoment | null = null;
    switch (p.hook_event_name) {
      case "SessionStart":
      case "UserPromptSubmit":
        Object.assign(patch, { state: "running", activity: null });
        break;
      case "PreToolUse":
        Object.assign(patch, { state: "running", activity: p.tool_name ? describeTool(p.tool_name, p.tool_input) : null });
        break;
      case "PostToolUse":
        Object.assign(patch, { state: "running", tool: true, activity: null });
        break;
      case "PostToolUseFailure":
        Object.assign(patch, { state: "running", tool: true, activity: p.tool_name ? `${p.tool_name} failed` : "a tool failed" });
        break;
      case "PermissionRequest":
        Object.assign(patch, { state: "waiting", activity: `needs your approval${p.tool_name ? `: ${p.tool_name}` : ""}` });
        break;
      case "Notification":
        if (p.notification_type === "permission_prompt") Object.assign(patch, { state: "waiting", activity: "needs your approval" });
        else if (p.notification_type === "idle_prompt") Object.assign(patch, { state: "waiting", activity: null });
        else if (p.notification_type === "agent_needs_input" || p.notification_type === "elicitation_dialog") Object.assign(patch, { state: "waiting", activity: "asking you something" });
        break;
      case "Stop": {
        const said = firstLine(p.last_assistant_message, 200);
        Object.assign(patch, { state: "waiting", activity: null, ...(said ? { summary: said } : {}) });
        if (p.last_assistant_message?.trim()) moment = { kind: "said", text: p.last_assistant_message.trim().slice(0, 600) };
        break;
      }
      case "StopFailure": {
        const why = [p.error_type, firstLine(p.error_message, 160)].filter(Boolean).join(" — ");
        Object.assign(patch, { state: "error", activity: null, summary: `stopped: ${why || "unknown error"}` });
        moment = { kind: "failed", text: why || "unknown error" };
        break;
      }
      case "SessionEnd":
        Object.assign(patch, { state: "ended", activity: null, endedAt: Date.now() });
        moment = { kind: "ended", text: p.reason ?? "" };
        break;
      default:
        break;
    }
    if (session.blocked && patch.state !== "ended") {
      patch.state = "error";
      delete patch.summary;
    }
    this.touch(projectId, sessionId, patch);
    if (moment) this.options.onMoment?.(this.store.session(projectId, sessionId) ?? session, moment);
    if (patch.state === "ended") this.release(sessionId);
    return {};
  }

  /** Any sign of life, with what it says about the session. */
  touch(projectId: string, sessionId: string, patch: { state?: SessionState; externalId?: string; endedAt?: number; tool?: boolean; summary?: string; activity?: string | null; blocked?: "credentials" | null } = {}): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    const now = Date.now();
    // An ended session stays ended; a late hook does not resurrect it.
    const blocked = patch.blocked === undefined ? session.blocked : patch.blocked;
    const requestedState = blocked && patch.state !== "ended" ? "error" : patch.state;
    const state = session.state === "ended" && requestedState !== "ended" ? undefined : requestedState;
    this.store.patchSession(projectId, sessionId, {
      lastEventAt: now,
      ...(patch.tool ? { lastToolAt: now } : {}),
      ...(state ? { state } : {}),
      ...(patch.externalId ? { externalId: patch.externalId } : {}),
      ...(patch.endedAt ? { endedAt: patch.endedAt } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.activity !== undefined ? { activity: patch.activity } : {}),
      ...(patch.blocked !== undefined ? { blocked: patch.blocked } : {})
    });
    this.options.onChange(projectId);
  }

  end(projectId: string, sessionId: string, state: "ended" | "lost" = "ended"): void {
    const session = this.store.session(projectId, sessionId);
    if (!session || session.state === "ended") return;
    this.store.patchSession(projectId, sessionId, { state, endedAt: Date.now(), activity: null });
    this.release(sessionId);
    this.options.onChange(projectId);
  }

  /** The process Tomrade launched for the session, if its script left a pid and it still answers. */
  private processAlive(sessionId: string): boolean | null {
    const file = path.join(this.options.dirOf(sessionId), "pid");
    let pid: number;
    try {
      pid = Number(fs.readFileSync(file, "utf8").trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM" ? true : false;
    }
  }

  /**
   * The clock's verdict on quiet sessions — idle after a while, over after a
   * long while — and the process's: a terminal Tomrade launched whose pid is
   * gone ended, however it ended, hook or no hook.
   */
  sweep(projectId: string, now = Date.now()): void {
    let changed = false;
    for (const s of this.store.sessions(projectId, { live: true })) {
      if (s.state === "lost") continue;
      if (s.mode === "terminal" && this.processAlive(s.id) === false) {
        this.store.patchSession(projectId, s.id, { state: "ended", endedAt: now, activity: null });
        this.release(s.id);
        this.options.onMoment?.(this.store.session(projectId, s.id)!, { kind: "ended", text: "process exited" });
        changed = true;
        continue;
      }
      const quiet = now - (s.lastEventAt ?? s.startedAt);
      if ((s.state === "running" || s.state === "waiting") && quiet >= IDLE_AFTER_MS) {
        this.store.patchSession(projectId, s.id, { state: "idle" });
        changed = true;
      } else if (s.state === "idle" && s.mode === "terminal" && quiet >= END_AFTER_MS && this.processAlive(s.id) === false) {
        this.store.patchSession(projectId, s.id, { state: "ended", endedAt: now, activity: null });
        this.release(s.id);
        changed = true;
      }
    }
    if (changed) this.options.onChange(projectId);
  }

  /** After a restart no headless process is left; the row says so, and the ticket still offers Continue. */
  reconcile(projectId: string): void {
    let changed = false;
    for (const s of this.store.sessions(projectId)) {
      if (s.mode === "headless" && s.state !== "ended" && s.state !== "lost") {
        this.store.patchSession(projectId, s.id, { state: "lost", activity: null });
        changed = true;
        continue;
      }
      // The app may restart while the terminal wrapper (and its agent) keeps
      // running. Preserve that session so a startup scan cannot call its
      // ticket merged merely because the old process lost its in-memory hook.
      if (s.mode === "terminal" && s.state === "ended" && this.processAlive(s.id) === true) {
        this.store.patchSession(projectId, s.id, { state: "running", endedAt: null });
        changed = true;
      }
    }
    if (changed) this.options.onChange(projectId);
  }
}

/** Claude Code settings that make every lifecycle event a POST to Tomrade. Loaded with `--settings`, so the repository is left alone. */
export function hooksSettings(eventUrl: string): Record<string, unknown> {
  const post = { type: "command", command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${eventUrl}' 2>/dev/null || true` };
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [post] }];
  return { hooks };
}
