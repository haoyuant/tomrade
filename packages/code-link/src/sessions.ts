import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/tools";
import type { Author } from "@tomradex/domain";
import { looksRateLimited, resetTime } from "@tomradex/agent";
import { classifyRemoteFailure, remoteFailureDetail } from "./remote.js";
import { CODE_WORDS } from "./words.js";
import type { CodeLinkStore, SessionBlock, SessionState, SessionView } from "./store.js";

/** How long a session may be silent before it counts as idle, and how long idle before it is over. */
export const IDLE_AFTER_MS = 10 * 60 * 1000;
export const END_AFTER_MS = 60 * 60 * 1000;
/** How long after a hook spoke herdr's reading of the screen is left unsaid. */
export const HERDR_YIELD_MS = 30 * 1000;

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
  /** StopFailure: what kind of failure ("rate_limit", "authentication_failed"…) and its detail. */
  error?: string;
  error_details?: string;
  /** The same, as Pi's bridge names them. */
  error_type?: string;
  error_message?: string;
  reason?: string;
  /** The herdr pane the hook ran in, from the header or the script. */
  herdr_pane?: string;
  /** Not a hook at all: herdr's reading of the pane, shaped like one. */
  herdr?: boolean;
}

/**
 * The Claude Code hook events a session listens to. Each says something about
 * the session; the ones that say nothing new still count as a sign of life.
 * `Stop` does not fire on a user interrupt — the process check covers that end.
 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "SubagentStop", "SessionEnd"] as const;

/**
 * A hook run inside a herdr pane says which one, so the ticket can find the
 * session there again; outside herdr the variable is empty and curl sends no
 * such header. Scripts that post from JavaScript add `herdr_pane` themselves.
 */
export const HERDR_PANE_HEADER = `-H "X-Tomrade-Herdr-Pane: $HERDR_PANE_ID"`;

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
  /** The process is over; code evidence may have changed while it was still counted as active. */
  onEnd?(session: SessionView): void;
  /** The session just turned to the person for something — an approval, an answer — and says what. */
  onWaiting?(session: SessionView, activity: string): void;
  /** The agent stopped on a usage limit, lifting at `until` when it said; returns what the session's summary should say. */
  onLimit?(session: SessionView, until: number | null): string;
}

export interface SessionFiles {
  dir: string;
  mcpConfig: string;
  settings: string;
  /** The extension a terminal pi session loads: the MCP server and hook-style reports in one. */
  piExtension: string;
  /** A Gemini CLI home for this session (`GEMINI_CLI_HOME`): the person's own ~/.gemini, with the server added to its settings. */
  geminiHome: string;
  /** OpenCode's own shape of the same MCP server. */
  opencodeConfig: string;
  /** DeepSeek Harness: a `--patch` overlay adding the server, and the script that shows its `--json` run and reports it. */
  dshPatch: string;
  dshReporter: string;
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
const MERGE_COMMAND = /(?:^|[;&|]\s*)gh\s+pr\s+merge\b/;
/** A refusal, not a slip the agent can correct (a missing flag, a typo). */
const MERGE_REFUSED = /not (?:allowed|permitted|mergeable)|protected branch|required status check|review(?:s)? (?:is |are )?required|approving review|denied|permission|blocked|policy|merge conflict|not authorized|forbidden|\b403\b/i;
/**
 * A ticket a coding session files is a follow-up, not more of its own work: it waits in Backlog, says
 * which session filed it, and is not filed at all when the backlog already holds the same thing.
 */
async function followUp(args: unknown, filed: string, call: ((tool: string, input: unknown) => Promise<unknown>) | null): Promise<unknown> {
  const input = { ...(args as { title?: string; body?: string | null; status?: string }) };
  const title = input.title?.trim();
  if (title && call) {
    const similar = (await call("find_similar", { title, ...(input.body ? { body: input.body } : {}) }).catch(() => null)) as { verdict?: string; matches?: { key: string; title: string }[] } | null;
    const same = similar?.verdict === "duplicate" ? similar.matches?.[0] : undefined;
    if (same) throw new Error(`create_item: ${same.key} (${same.title}) already describes this — mention it when you sync instead of filing another ticket`);
  }
  return { ...input, status: input.status ?? "backlog", ...(filed ? { body: input.body ? `${input.body}\n\n${filed}` : filed } : {}) };
}

/** Backlog planning and status writes do not belong to a ticket's coding session; filing a follow-up does. */
const OUT_OF_SCOPE_TOOLS = new Set([
  "update_item",
  "change_status",
  "delete_item",
  "create_workstream",
  "update_workstream",
  "remove_workstream",
  "update_dossier",
  "plan_and_apply",
  "update_project_brief"
]);

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
  /** When each session's own hooks last spoke, which herdr's reading of the screen defers to. */
  private readonly heardAt = new Map<string, number>();

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
    const items = this.ctx.get("items");
    const settings = this.ctx.get("settings");
    return {
      author,
      projectId: session.projectId,
      execute: async (name: string, args: unknown, signal?: AbortSignal) => {
        if (OUT_OF_SCOPE_TOOLS.has(name)) {
          throw new Error(`${name}: a coding session cannot edit the backlog or another ticket — finish the current ticket, then use a separate planning or coding session`);
        }
        this.touch(session.projectId, session.id, { state: "running", tool: true });
        const call = (tool: string, input: unknown) => sessionContext.run({ projectId: session.projectId, sessionId: session.id }, () => tools.execute(tool, input, { by: author, projectId: session.projectId, signal }));
        if (name !== "create_item") return call(name, args);
        const owner = this.store.session(session.projectId, session.id)?.itemIds[0];
        const key = owner ? items?.get(session.projectId, owner)?.key : undefined;
        const filed = key ? CODE_WORDS(settings?.locale?.())("filedFrom", { key }) : "";
        return call(name, await followUp(args, filed, tools.has("find_similar") ? call : null));
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
    const piFile = path.join(dir, "pi-extension.ts");
    const geminiHome = path.join(dir, "gemini-home");
    const opencodeConfig = path.join(dir, "opencode.json");
    const dshPatch = path.join(dir, "dsh-patch.yml");
    const dshReporter = path.join(dir, "dsh-report.mjs");
    const promptFile = path.join(dir, "prompt.md");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tomrade: { type: "http", url: mcpUrl, headers: { "X-Tomrade-Run": token } } } }, null, 2));
    fs.writeFileSync(settings, JSON.stringify(hooksSettings(eventUrl), null, 2));
    fs.writeFileSync(piFile, piExtension(mcpUrl, token, eventUrl));
    writeGeminiHome(geminiHome, { tomrade: { httpUrl: mcpUrl, headers: { "X-Tomrade-Run": token } } });
    fs.writeFileSync(opencodeConfig, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { tomrade: { type: "remote", url: mcpUrl, enabled: true, headers: { "X-Tomrade-Run": token } } } }, null, 2));
    fs.writeFileSync(dshPatch, dshMcpPatch(mcpUrl, token));
    fs.writeFileSync(dshReporter, dshReport(eventUrl));
    fs.writeFileSync(promptFile, prompt);
    fs.rmSync(path.join(dir, "pid"), { force: true });
    return { dir, mcpConfig, settings, piExtension: piFile, geminiHome, opencodeConfig, dshPatch, dshReporter, prompt: promptFile, mcpUrl, eventUrl, token };
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

  /** The agent was not let merge its pull request: a stop only the person clears, by merging it. */
  blockMerge(projectId: string, sessionId: string, reason: string, patch: { externalId?: string; tool?: boolean } = {}): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    const summary = `merge blocked: ${firstLine(reason, 200) || "refused"}`;
    this.touch(projectId, sessionId, { ...patch, state: "error", summary, activity: null, blocked: "merge" });
    this.options.onMoment?.(this.store.session(projectId, sessionId) ?? session, { kind: "failed", text: summary });
  }

  /** A hook fired in the agent's process: what it says about the session, and what the thread should hear. */
  event(projectId: string, sessionId: string, payload: unknown): Record<string, unknown> {
    const p = (payload ?? {}) as HookPayload;
    const session = this.store.session(projectId, sessionId);
    if (!session) return {};
    // herdr reads the screen; a hook that spoke a moment ago knows better. The pane closing is the end whatever was said.
    if (p.herdr) {
      if (p.hook_event_name !== "SessionEnd" && Date.now() - (this.heardAt.get(sessionId) ?? 0) < HERDR_YIELD_MS) return {};
    } else this.heardAt.set(sessionId, Date.now());
    const patch: Parameters<Sessions["touch"]>[2] = {};
    if (typeof p.session_id === "string" && p.session_id) patch.externalId = p.session_id;
    if (typeof p.herdr_pane === "string" && p.herdr_pane.trim()) patch.herdrPane = p.herdr_pane.trim();
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
    if (command && MERGE_COMMAND.test(command) && MERGE_REFUSED.test(failedOutput)) {
      this.blockMerge(projectId, sessionId, failedOutput, { ...(patch.externalId ? { externalId: patch.externalId } : {}), tool: true });
      return { additionalContext: "Tomrade: the merge was refused and the person has been handed it. Do not try to merge another way — stop here." };
    }
    let moment: SessionMoment | null = null;
    switch (p.hook_event_name) {
      case "SessionStart":
      case "UserPromptSubmit":
        Object.assign(patch, { state: "running", activity: null });
        // the person went on by hand: a limit it waited for is no longer anyone's to announce
        if (session.threadId) this.ctx.get("agent")?.unpark(projectId, session.threadId);
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
        const kind = p.error ?? p.error_type;
        const detail = p.error_details ?? p.error_message ?? p.last_assistant_message;
        const why = [kind, firstLine(detail, 160)].filter(Boolean).join(" — ");
        const limited = kind === "rate_limit" || looksRateLimited(detail) ? this.options.onLimit?.(session, resetTime(detail)) : undefined;
        Object.assign(patch, { state: "error", activity: null, summary: limited ?? `stopped: ${why || "unknown error"}` });
        moment = { kind: "failed", text: limited ?? (why || "unknown error") };
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
    const turned = patch.state === "waiting" && !!patch.activity && !(session.state === "waiting" && session.activity === patch.activity);
    this.touch(projectId, sessionId, patch);
    if (turned) this.options.onWaiting?.(this.store.session(projectId, sessionId) ?? session, patch.activity!);
    if (moment) this.options.onMoment?.(this.store.session(projectId, sessionId) ?? session, moment);
    if (patch.state === "ended") {
      this.release(sessionId);
      const ended = this.store.session(projectId, sessionId);
      if (ended) this.options.onEnd?.(ended);
    }
    return {};
  }

  /** Any sign of life, with what it says about the session. */
  touch(projectId: string, sessionId: string, patch: { state?: SessionState; externalId?: string; herdrPane?: string; endedAt?: number; tool?: boolean; summary?: string; activity?: string | null; blocked?: SessionBlock | null } = {}): void {
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
      ...(patch.herdrPane ? { herdrPane: patch.herdrPane } : {}),
      ...(patch.endedAt ? { endedAt: patch.endedAt } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.activity !== undefined ? { activity: patch.activity } : {}),
      ...(patch.blocked !== undefined ? { blocked: patch.blocked } : {})
    });
    this.options.onChange(projectId);
  }

  /** `quiet` skips the follow-up rescan, for sessions closed because their tickets are already done. */
  end(projectId: string, sessionId: string, state: "ended" | "lost" = "ended", quiet = false): void {
    const session = this.store.session(projectId, sessionId);
    if (!session || session.state === "ended") return;
    this.store.patchSession(projectId, sessionId, { state, endedAt: Date.now(), activity: null });
    this.release(sessionId);
    this.options.onChange(projectId);
    if (state === "ended" && !quiet) this.options.onEnd?.(this.store.session(projectId, sessionId)!);
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
    const ended: SessionView[] = [];
    for (const s of this.store.sessions(projectId, { live: true })) {
      if (s.state === "lost") continue;
      if (s.mode === "terminal" && this.processAlive(s.id) === false) {
        this.store.patchSession(projectId, s.id, { state: "ended", endedAt: now, activity: null });
        this.release(s.id);
        this.options.onMoment?.(this.store.session(projectId, s.id)!, { kind: "ended", text: "process exited" });
        ended.push(this.store.session(projectId, s.id)!);
        changed = true;
        continue;
      }
      const quiet = now - (s.lastEventAt ?? s.startedAt);
      // Silence means the hooks stopped reaching us while it ran; a session waiting for
      // the person stays waiting however long they are away (a dead process ends it above).
      if (s.state === "running" && quiet >= IDLE_AFTER_MS) {
        this.store.patchSession(projectId, s.id, { state: "idle" });
        changed = true;
      } else if (s.state === "idle" && s.mode === "terminal" && quiet >= END_AFTER_MS && this.processAlive(s.id) === false) {
        this.store.patchSession(projectId, s.id, { state: "ended", endedAt: now, activity: null });
        this.release(s.id);
        ended.push(this.store.session(projectId, s.id)!);
        changed = true;
      }
    }
    if (changed) this.options.onChange(projectId);
    for (const session of ended) this.options.onEnd?.(session);
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

/** Plain JSON from JSON with comments and trailing commas, as Gemini CLI and OpenCode read their settings. */
export function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  // Strings are matched whole first, so only a comma outside them is dropped.
  return out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_, string: string | undefined, close: string) => string ?? close);
}

/**
 * A Gemini CLI home for one terminal session. Gemini 0.64 skips a system
 * defaults file that root does not own, so the session's server goes into
 * user settings instead: a copy of the person's own with the server added.
 * Every other entry of their ~/.gemini (sign-in, extensions, history, trust)
 * is linked, so the session reads and writes those as always. A file Gemini
 * replaces whole stays in the copy: a settings change made during the
 * session, and its project list, whose folders it finds again by their marker.
 */
export function writeGeminiHome(home: string, servers: Record<string, unknown>, source = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini")): void {
  const own = path.join(home, ".gemini");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(own, { recursive: true });
  const link = (target: string, at: string) => {
    try {
      fs.symlinkSync(target, at, process.platform === "win32" && fs.statSync(target).isDirectory() ? "junction" : undefined);
    } catch {
      // Windows without the right to make file links: a copy still signs the session in.
      try { if (fs.statSync(target).isFile()) fs.copyFileSync(target, at); } catch { /* a link to nothing is left out */ }
    }
  };
  let settings: Record<string, unknown> = {};
  for (const name of fs.existsSync(source) ? fs.readdirSync(source) : []) {
    if (name !== "settings.json") link(path.join(source, name), path.join(own, name));
  }
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(path.join(source, "settings.json"), "utf8"))) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // None, or one Gemini could not read either: the session starts from the server alone.
  }
  // Gemini looks for ~/.env last, under the home it was given.
  const dotenv = path.join(path.dirname(source), ".env");
  if (fs.existsSync(dotenv)) link(dotenv, path.join(home, ".env"));
  const mcpServers = { ...((settings.mcpServers as Record<string, unknown> | undefined) ?? {}), ...servers };
  fs.writeFileSync(path.join(own, "settings.json"), JSON.stringify({ ...settings, mcpServers }, null, 2));
}

/** Claude Code settings that make every lifecycle event a POST to Tomrade. Loaded with `--settings`, so the repository is left alone. */
export function hooksSettings(eventUrl: string): Record<string, unknown> {
  const post = { type: "command", command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' ${HERDR_PANE_HEADER} --data-binary @- '${eventUrl}' 2>/dev/null || true` };
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [post] }];
  return { hooks };
}

/**
 * Pi has neither an MCP flag nor command hooks, so its terminal session loads
 * this extension instead: it registers Tomrade's server for the session and
 * posts the same events Claude's hooks do, under Claude's tool names, so the
 * session reads alike. A deny or extra context in the reply is honoured.
 */
export function piExtension(mcpUrl: string, token: string, eventUrl: string): string {
  const server = { url: mcpUrl, headers: { "X-Tomrade-Run": token }, exposure: "direct", timeout: 600 };
  return `const server = ${JSON.stringify(server)};
const eventUrl = ${JSON.stringify(eventUrl)};
const names = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };
const textOf = (content) => (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n");
const pane = process.env.HERDR_PANE_ID ? { herdr_pane: process.env.HERDR_PANE_ID } : {};

export default function (pi) {
  pi.registerMcpServer("tomrade", server);
  let sessionId;
  const post = (payload) => fetch(eventUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, ...pane, ...payload }), signal: AbortSignal.timeout(5000) })
    .then((response) => response.json()).catch(() => ({}));
  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    await post({ hook_event_name: "SessionStart" });
  });
  pi.on("agent_start", () => { void post({ hook_event_name: "UserPromptSubmit" }); });
  pi.on("tool_call", async (event) => {
    const reply = await post({ hook_event_name: "PreToolUse", tool_name: names[event.toolName] ?? event.toolName, tool_input: event.input });
    const decision = reply.hookSpecificOutput;
    if (decision?.permissionDecision === "deny") return { block: true, reason: decision.permissionDecisionReason };
  });
  pi.on("tool_result", async (event) => {
    const text = textOf(event.content);
    const reply = await post({ hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse", tool_name: names[event.toolName] ?? event.toolName,
      tool_input: event.input, ...(event.isError ? { tool_error: text } : { tool_output: text }) });
    if (reply.additionalContext) return { content: [...event.content, { type: "text", text: reply.additionalContext }] };
  });
  pi.on("agent_end", (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (last?.stopReason === "error") void post({ hook_event_name: "StopFailure", error_message: last.errorMessage });
    else if (last) void post({ hook_event_name: "Stop", last_assistant_message: textOf(last.content) });
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") await post({ hook_event_name: "SessionEnd", reason: "exit" });
  });
}
`;
}

/**
 * DeepSeek Harness takes extra configuration as a `--patch` overlay: this one
 * adds Tomrade's server, with the session's token, for that run alone.
 */
export function dshMcpPatch(mcpUrl: string, token: string): string {
  return [
    "- insert:",
    "    - id: tomrade-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: tomrade",
    "        transport: streamable-http",
    `        url: ${JSON.stringify(mcpUrl)}`,
    "        headers:",
    `          X-Tomrade-Run: ${JSON.stringify(token)}`,
    // Compound tools call a worker model and can outlast the 60s default.
    "        toolCallTimeoutMs: 600000",
    ""
  ].join("\n");
}

/**
 * DeepSeek Harness has no interactive terminal of its own: a ticket runs as
 * `dsh --profile headless --json`, piped through this script, which prints the
 * run for the person and posts the events Claude's hooks would — the session
 * id first, so Continue can resume it with `--session-id`.
 */
export function dshReport(eventUrl: string): string {
  return `import readline from "node:readline";
const eventUrl = ${JSON.stringify(eventUrl)};
const names = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", glob: "Glob" };
let sessionId;
const sent = [];
const pane = process.env.HERDR_PANE_ID ? { herdr_pane: process.env.HERDR_PANE_ID } : {};
const post = (payload) => { sent.push(fetch(eventUrl, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ session_id: sessionId, ...pane, ...payload }), signal: AbortSignal.timeout(5000) }).catch(() => {})); };
const brief = (input) => { const text = typeof input === "string" ? input : JSON.stringify(input ?? {}); return text.length > 120 ? text.slice(0, 117) + "..." : text; };
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { console.log(line); return; }
  if (event.type === "session") {
    sessionId = event.sessionId;
    console.log("DeepSeek Harness session " + sessionId);
    post({ hook_event_name: "SessionStart" });
    post({ hook_event_name: "UserPromptSubmit" });
  } else if (event.type === "tool_call") {
    console.log("> " + event.tool + " " + brief(event.input?.command ?? event.input));
    post({ hook_event_name: "PreToolUse", tool_name: names[event.tool] ?? event.tool, tool_input: event.input ?? {} });
  } else if (event.type === "tool_result") {
    const failed = event.status !== "completed";
    post({ hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse", tool_name: names[event.tool] ?? event.tool,
      ...(failed ? { tool_error: brief(event.result) } : { tool_output: String(event.result ?? "").slice(0, 2000) }) });
  } else if (event.type === "text") console.log(event.text);
  else if (event.type === "final") post({ hook_event_name: "Stop", last_assistant_message: event.text });
  else if (event.type === "error") {
    console.error(event.message);
    post({ hook_event_name: "StopFailure", error_message: event.message });
  }
});
lines.on("close", async () => {
  await Promise.all(sent);
  post({ hook_event_name: "SessionEnd", reason: "exit" });
  await Promise.all(sent);
});
`;
}
