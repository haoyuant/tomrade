import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { herdrInstall, type HerdrInstall } from "@tomradex/herdr";
import type { TerminalPaneEvent, TerminalPaneInfo } from "@tomradex/contracts";
import { named, SESSION_STATES, STATUSES } from "./contrib.js";
import type { Sessions } from "./sessions.js";
import type { CodeLinkStore, SessionView } from "./store.js";
import { RESUME_ID_FILE, RESUME_SCRIPT, SYSTEM_TERMINAL, commandOk, herdrFallbackNote, launchTerminal, machineTerminalSettings, panesOf, setupTerminal, shellQuote, type LaunchInput, type LaunchResult, type TerminalPath, type TerminalSettings } from "./terminal.js";
import type { CodeWords } from "./words.js";
import { errorMessage } from "@tomradex/contracts";

export type { HerdrInstall };

/** How often a terminal session whose hooks name no pane asks the terminal backend which pane runs it. */
const PANE_LOOK_MS = 15_000;
/** How soon a session still without its agent's id looks at its pane again: one herdr call, on herdr's own events only. */
const ID_LOOK_MS = 2_000;

/** The name herdr knows an engine's CLI by. */
const herdrAgentOf = (engine: string): string => ({ "claude-code": "claude", workbuddy: "codebuddy", gemini: "gemini", cursor: "cursor-agent", dsh: "dsh" } as Record<string, string>)[engine] ?? engine;

/** The last line of a pane that says something — not the input box, a rule, or a shortcut hint — for a summary. */
export function lastSaid(screen: string | null): string {
  if (!screen) return "";
  const lines = screen.split("\n").map((line) => line.replace(/[\u2500-\u257f]/g, " ").trim()).filter((line) => line && !/^[>❯$%#│|?]+$/.test(line) && !/^\? for shortcuts|^esc to interrupt|^\d+ tokens?\b|^ctrl\+/i.test(line));
  return (lines.at(-1) ?? "").replace(/^[>❯]\s*/, "").slice(0, 200);
}


export interface HerdrBridgeDeps {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  words: () => CodeWords;
  sessionDir: (sessionId: string) => string;
}

/**
 * Everything code-link does with herdr, the terminal workspace sessions run
 * in: its status and install, the terminal sessions and setup commands open
 * in, a prompt into a session's pane, showing it, finding the pane of a
 * session, and following the panes of live sessions.
 */
export class HerdrBridge {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly sessions: Sessions;
  private readonly words: HerdrBridgeDeps["words"];
  private readonly sessionDir: HerdrBridgeDeps["sessionDir"];
  /** When each session last asked herdr for its pane. */
  private readonly paneLooked = new Map<string, number>();
  /** When each session its hooks never named looked for the id herdr's own integration reported on its pane. */
  private readonly idLooked = new Map<string, number>();

  constructor(deps: HerdrBridgeDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.words = deps.words;
    this.sessionDir = deps.sessionDir;
  }

  /** Once a terminal backend is there: its reading of the panes ticket sessions run in, as the hook events those sessions would post. */
  follow(home: Context): void {
    home.inject(["terminals"], (ctx) => this.followPanes(ctx));
  }

  /** herdr, while it is the terminal backend: what only herdr does (its sidebar, its own restore, its toasts, its window). */
  private herdr() {
    return this.ctx.get("terminals")?.kind === "herdr" ? this.ctx.get("herdr") : undefined;
  }

  /** The terminal settings as this machine runs them: automatic means herdr once it is installed, Tomrade's own terminal on Windows. */
  terminalSettings(): Promise<TerminalSettings> {
    return machineTerminalSettings(this.ctx.settings.get().codeLink, this.ctx.get("terminals"));
  }

  /** A session's script in that terminal; a terminal of panes opens one, or the system terminal when the backend does not answer. */
  launch(input: LaunchInput, terminal: string): Promise<LaunchResult> {
    return launchTerminal(input, terminal, this.ctx.get("terminals") ?? null);
  }

  /** One setup command in this machine's terminal, where the person watches it. */
  async setup(command: string, dir: string, dirs?: TerminalPath): Promise<{ launched: boolean }> {
    return setupTerminal(command, dir, (await this.terminalSettings()).terminal, this.ctx.get("terminals") ?? null, dirs);
  }

  /** What to tell the person after a launch went elsewhere, or herdr was started for it; null otherwise. */
  fallbackNote(locale: unknown, launch: LaunchResult): string | null {
    return herdrFallbackNote(locale, launch);
  }

  /** Whether a pane still runs; null when the backend cannot tell, or is not there. */
  async paneAlive(pane: string): Promise<boolean | null> {
    return (await this.ctx.get("terminals")?.paneAlive(pane)) ?? null;
  }

  /** What the backend says of one pane: the agent in it and its title; null when it or the pane is not there. */
  async pane(pane: string): Promise<TerminalPaneInfo | null> {
    return (await this.ctx.get("terminals")?.panes())?.find((x) => x.paneId === pane) ?? null;
  }

  /** Types a line into a pane; false without a backend. */
  async prompt(pane: string, text: string): Promise<boolean> {
    return (await this.ctx.get("terminals")?.prompt(pane, text)) ?? false;
  }

  private followPanes(ctx: Context): void {
    ctx.terminals.onPane((event) => void this.herdrEvent(ctx, event).catch((err) => this.ctx.logger.warn(`terminal event on ${event.paneId} failed: ${errorMessage(err)}`)));
    ctx.effect(() => () => {
      for (const release of this.herdrHolds.values()) release();
      this.herdrHolds.clear();
    });
    this.watchPanes(ctx);
    ctx.on("codeLink/changed", () => this.watchPanes(ctx));
    // a ticket moved (by a person, a scan, a merge) shows on its workspace too
    ctx.on("write/committed", (intent) => { if (intent.entity === "item") this.watchPanes(ctx); });
  }

  /** In a herdr pane the person may be at the terminal: herdr tells them there too (the desktop keeps the count, not the toast). */
  waiting(session: SessionView, activity: string): void {
    if (!session.herdrPane) return;
    const key = session.itemIds[0] ? this.ctx.items.get(session.projectId, session.itemIds[0])?.key : undefined;
    const who = key ?? this.ctx.get("agent")?.codeEngines().find((e) => e.id === session.agent)?.title ?? session.agent;
    void this.herdr()?.notify(this.words()("herdrNeedsYou", { what: who }), activity, "request");
  }

  /** Machine-local readiness; it informs Start without gating it. */
  async herdrStatus(): Promise<"notInstalled" | "notRunning" | "running"> {
    const herdr = this.ctx.get("herdr");
    if (await herdr?.server()) return "running";
    return await herdr?.installed() ? "notRunning" : "notInstalled";
  }

  /** Tomrade's own Terminal window shows this project's sessions: the terminal here opens panes and a window answers for it. */
  async terminalWindow(projectId: string): Promise<boolean> {
    const settings = await this.terminalSettings();
    return !!panesOf(settings.terminal) && (await this.answered("codeLink/terminal-window", () => this.ctx.serial("codeLink/terminal-window", projectId)));
  }

  /** A session's herdr terminal, shown in Tomrade's Terminal window; false when no window can show it. */
  showSession(projectId: string, sessionId: string): Promise<boolean> {
    return this.answered("codeLink/show-session", () => this.ctx.serial("codeLink/show-session", projectId, sessionId));
  }

  /** An ended session's conversation taken up again in a new cell of Tomrade's Terminal window; false when no window can. */
  resumeSession(projectId: string, sessionId: string): Promise<boolean> {
    return this.answered("codeLink/resume-session", () => this.ctx.serial("codeLink/resume-session", projectId, sessionId));
  }

  /** Whether the Terminal window recorded what the session's pane showed. */
  rawOutputThere(projectId: string, sessionId: string): Promise<boolean> {
    return this.answered("codeLink/raw-output-there", () => this.ctx.serial("codeLink/raw-output-there", projectId, sessionId));
  }

  /** A plugin's answer is a convenience: one that throws counts as no window. */
  private async answered(name: string, ask: () => Promise<unknown>): Promise<boolean> {
    try {
      return (await ask()) === true;
    } catch (error) {
      this.ctx.logger.warn(`${name}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** The ticket's live session brought forward in herdr itself, said in a line; null when it has no herdr pane to show. */
  async showInHerdr(projectId: string, itemId: string): Promise<string | null> {
    const pane = this.store.sessions(projectId, { itemId, live: true }).find((s) => s.herdrPane && s.state !== "lost")?.herdrPane;
    const herdr = this.herdr();
    if (!pane || !herdr) return null;
    const w = this.words();
    const item = this.ctx.items.get(projectId, itemId);
    const shown = await herdr.show(pane, item ? `${item.key} · ${item.title}` : pane);
    if (shown === "shown") return w("shownInHerdr", { pane });
    // In front, but no herdr client is attached to see it: herdr's own client, in the system terminal, shows it.
    if (shown === "noClient") {
      const attach = await launchTerminal({ cwd: os.homedir(), command: `exec ${shellQuote(herdr.binary() ?? "herdr")}`, dir: this.sessionDir("herdr-attach") }, SYSTEM_TERMINAL);
      return attach.launched ? w("herdrAttached", { app: process.platform === "darwin" ? SYSTEM_TERMINAL : w("systemTerminal"), pane }) : w("herdrRunToSee", { pane });
    }
    return null;
  }

  /** Homebrew's formula only where brew answers; Windows has none. */
  async herdrInstall(): Promise<HerdrInstall> {
    return herdrInstall({ brew: process.platform !== "win32" && (await commandOk("brew")) });
  }

  /** Runs only on a person's click, in a terminal they watch, like an engine's install. */
  async installHerdr(plan: HerdrInstall): Promise<{ launched: boolean; command: string }> {
    const { command } = plan;
    if (!command) throw new Error(this.words()("herdrNoInstaller"));
    const { launched } = await this.setup(command, path.join(this.sessionDir("setup"), "herdr"));
    return { launched, command };
  }

  /**
   * Hooks committed before they named their herdr pane say nothing of where the agent runs. herdr knows which pane
   * holds the agent's own session, so a terminal session without a pane takes that one.
   */
  findPane(projectId: string, sessionId: string, payload: unknown): void {
    const p = payload as { session_id?: unknown; herdr_pane?: unknown; hook_event_name?: unknown };
    if (typeof p.session_id !== "string" || !p.session_id || p.herdr_pane || p.hook_event_name === "SessionEnd") return;
    const herdr = this.ctx.get("terminals");
    const session = this.store.session(projectId, sessionId);
    if (!herdr || !session || session.mode !== "terminal" || session.herdrPane) return;
    const now = Date.now();
    if (now - (this.paneLooked.get(sessionId) ?? 0) < PANE_LOOK_MS) return;
    this.paneLooked.set(sessionId, now);
    const externalId = p.session_id;
    void herdr
      .panes()
      .then((panes) => {
        const pane = panes?.find((x) => x.agentSession === externalId);
        const current = this.store.session(projectId, sessionId);
        if (!pane || !current || current.herdrPane || current.state === "ended" || current.state === "lost") return;
        this.paneLooked.delete(sessionId);
        this.sessions.touch(projectId, sessionId, { herdrPane: pane.paneId });
      })
      .catch((err) => this.ctx.logger.warn(`finding the pane of ${sessionId}: ${errorMessage(err)}`));
  }

  /** The panes this service follows in herdr; others (the Terminal window's) follow theirs. */
  private readonly herdrHolds = new Map<string, () => void>();

  /** What herdr was last told about each session with a pane, so it is told only what changed. */
  private readonly herdrTold = new Map<string, { tokens?: string; resume?: string }>();

  /**
   * Every live session with a pane is followed in herdr, and herdr is kept told about it: the
   * ticket and where it stands on the pane, and — once the hooks have said the agent's own
   * session id — how to bring the session back, connected, after a restart of herdr's own. A
   * session that ended is let go, and its pane cleared.
   */
  private watchPanes(ctx: Context): void {
    const wanted = new Set<string>();
    const seen = new Set<string>();
    const w = this.words();
    const herdr = this.herdr();
    for (const projectId of this.ctx.db.openIds()) {
      for (const s of this.store.sessions(projectId)) {
        if (!s.herdrPane) continue;
        const live = s.state !== "ended" && s.state !== "lost";
        const told = this.herdrTold.get(s.id) ?? {};
        if (live) {
          wanted.add(s.herdrPane);
          seen.add(s.id);
          const item = s.itemIds[0] ? this.ctx.items.get(projectId, s.itemIds[0]) : undefined;
          const tokens = { ticket: item?.key ?? null, status: item ? named(w, STATUSES, item.status) : null, session: named(w, SESSION_STATES, s.state) };
          const wanting = JSON.stringify(tokens);
          if (herdr && told.tokens !== wanting) {
            this.herdrTold.set(s.id, { ...told, tokens: wanting });
            void herdr.reportMetadata(s.herdrPane, tokens).then((ok) => { if (!ok) this.herdrTold.set(s.id, { ...(this.herdrTold.get(s.id) ?? {}), tokens: undefined }); });
          }
          const script = path.join(this.sessionDir(s.id), RESUME_SCRIPT);
          if (herdr && s.externalId && told.resume !== s.externalId && fs.existsSync(script)) {
            this.herdrTold.set(s.id, { ...(this.herdrTold.get(s.id) ?? {}), resume: s.externalId });
            fs.writeFileSync(path.join(this.sessionDir(s.id), RESUME_ID_FILE), s.externalId);
            void herdr.reportSession(s.herdrPane, herdrAgentOf(s.agent), s.externalId, ["bash", script]).then((ok) => { if (!ok) this.herdrTold.set(s.id, { ...(this.herdrTold.get(s.id) ?? {}), resume: undefined }); });
          }
        } else if (told.tokens) {
          this.herdrTold.delete(s.id);
          void herdr?.reportMetadata(s.herdrPane, { ticket: null, status: null, session: null });
        }
      }
    }
    for (const id of this.herdrTold.keys()) if (!seen.has(id)) this.herdrTold.delete(id);
    for (const [paneId, release] of this.herdrHolds) {
      if (wanted.has(paneId)) continue;
      release();
      this.herdrHolds.delete(paneId);
    }
    // A pane the backend stopped following (it said the pane was gone) is followed afresh while a session still wants it.
    const watching = new Set(ctx.terminals.watching());
    for (const paneId of wanted) if (!this.herdrHolds.has(paneId) || !watching.has(paneId)) this.herdrHolds.set(paneId, ctx.terminals.watch(paneId));
  }

  /**
   * An agent whose hooks cannot reach Tomrade (Antigravity reads them only from the person's global configuration) may
   * still have told herdr its conversation, through herdr's own integration for it: a session nothing has named takes
   * the id its pane reports, when the pane runs that agent. Looked for on herdr's own events, at most once an
   * ID_LOOK_MS per session — a short turn has few of them — so the record can be read once it ends.
   */
  private async learnId(projectId: string, session: SessionView, paneId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.idLooked.get(session.id) ?? 0) < ID_LOOK_MS) return;
    this.idLooked.set(session.id, now);
    const pane = (await this.ctx.get("terminals")?.panes())?.find((x) => x.paneId === paneId);
    const current = this.store.session(projectId, session.id);
    if (!pane?.agentSession || pane.agent !== session.agent || !current || current.externalId || current.herdrPane !== paneId) return;
    this.idLooked.delete(session.id);
    this.sessions.touch(projectId, session.id, { externalId: pane.agentSession });
  }

  /**
   * What herdr reads on a session's pane, said the way the session's hooks would say it: working
   * is a tool starting, blocked a permission asked, done a stop with the screen's last line for
   * what was said, the pane going the session's end. Idle and unknown say nothing; a hook that
   * spoke a moment ago is believed over the screen (see Sessions.event).
   */
  private async herdrEvent(ctx: Context, event: TerminalPaneEvent): Promise<void> {
    for (const projectId of this.ctx.db.openIds()) {
      const session = this.store.sessions(projectId, { live: true }).find((s) => s.herdrPane === event.paneId && s.state !== "lost");
      if (!session) continue;
      if (event.kind === "exited") {
        this.sessions.event(projectId, session.id, { hook_event_name: "SessionEnd", reason: "pane closed", herdr: true, herdr_pane: event.paneId });
        return;
      }
      // looked up beside the event, never before it: an event that waited on it could land after the next one
      if (!session.externalId) void this.learnId(projectId, session, event.paneId).catch((err) => this.ctx.logger.warn(`reading ${event.paneId}'s agent session: ${errorMessage(err)}`));
      const name = event.status === "working" ? "PreToolUse" : event.status === "blocked" ? "PermissionRequest" : event.status === "done" ? "Stop" : null;
      if (!name) return;
      const said = name === "Stop" ? lastSaid(await ctx.terminals.readTail(event.paneId)) : "";
      this.sessions.event(projectId, session.id, { hook_event_name: name, herdr: true, ...(said ? { last_assistant_message: said } : {}) });
      return;
    }
  }
}
