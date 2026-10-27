import type { Context } from "cordis";
import type { EngineApproval } from "@tomradex/agent";
import type { TerminalInput } from "@tomradex/contracts";
import { PROMPT_LINES, promptOnScreen } from "./prompt.js";
import type { CodeLinkStore, SessionView } from "./store.js";

/** The most of a pane's screen one read of its tail takes. */
const TAIL_MAX = 200;
/** How soon a waiting session whose screen showed no prompt is looked at again. */
const GLANCE_RECHECK_MS = 2000;
/** What the hooks say while a session waits on a permission: only those screens are read for a prompt. */
const APPROVAL_ASK = /^needs your approval/i;

/** What the session lists show of a live terminal session without opening it: whether its card can answer its prompt. */
export interface SessionGlance {
  /** Its agent declared the keys that answer its permission prompt. */
  approval: boolean;
  /** What its screen asks that those keys answer now: a prompt with yes under the cursor, one with no, or nothing. */
  prompt: "allow" | "deny" | null;
}

/** What answering a session's permission prompt came to: answered, nothing pressed for a screen that asks no such thing, or failed. */
export type AnswerResult = "answered" | "notPrompt" | "failed";


/** What the assistant panel can do with a terminal session besides read its conversation. */
export interface SessionPanelView {
  /** The pane it runs in; null outside Tomrade's terminals. */
  pane: string | null;
  /** Whether this machine's terminal backend types into that pane, or why not. */
  input: "ok" | "ended" | "noPane" | "noBackend" | "unsupported";
  /** Its agent said how its permission prompt is answered from the keyboard. */
  approval: boolean;
}

/**
 * Keys as an agent declares them, as the sends that press them in that order: characters are typed as text and
 * named keys pressed after it, so a character that follows a key starts a send of its own.
 */
export function inputsOf(keys: string[]): TerminalInput[] {
  const sends: TerminalInput[] = [];
  for (const key of keys) {
    const last = sends.at(-1);
    if ([...key].length === 1) {
      if (last && !last.keys?.length) last.text = (last.text ?? "") + key;
      else sends.push({ text: key });
    } else if (last) (last.keys ??= []).push(key);
    else sends.push({ keys: [key] });
  }
  return sends;
}

/**
 * The assistant panel's side of a terminal session: reading the pane's screen, typing into it and answering its
 * agent's permission prompt — all through the backend's pane surface, which takes the pane from nobody (a control
 * session would, TOM-412) and works before an agent is detected in it. Nothing here starts a process.
 */
export class SessionPanel {
  /** Each session's last read prompt: kept until its next event, and one not seen is looked for again at most every GLANCE_RECHECK_MS. */
  private readonly seen = new Map<string, { event: number | null; at: number; prompt: SessionGlance["prompt"] }>();

  constructor(
    private readonly ctx: Context,
    private readonly store: CodeLinkStore
  ) {}

  private terminals() {
    return this.ctx.get("terminals");
  }

  private approvalOf(agent: string): EngineApproval | null {
    return this.ctx.get("agent")?.engineOf(agent)?.local?.approval ?? null;
  }

  private live(projectId: string, sessionId: string): SessionView | null {
    const s = this.store.session(projectId, sessionId);
    return s && s.state !== "ended" && s.state !== "lost" ? s : null;
  }

  view(projectId: string, sessionId: string): SessionPanelView {
    const s = this.store.session(projectId, sessionId);
    const terminals = this.terminals();
    const live = !!this.live(projectId, sessionId);
    const input = !s || !live ? "ended" : !s.herdrPane ? "noPane" : !terminals ? "noBackend" : !terminals.sendInput ? "unsupported" : "ok";
    return { pane: s?.herdrPane ?? null, input, approval: !!s && !!this.approvalOf(s.agent) };
  }

  /** Text into the session's pane, with Enter, as typed at its keyboard. False when it could not go. */
  async say(projectId: string, sessionId: string, text: string): Promise<boolean> {
    const s = this.live(projectId, sessionId);
    const terminals = this.terminals();
    if (!s?.herdrPane || !terminals?.sendInput || !text) return false;
    return terminals.sendInput(s.herdrPane, { text, keys: ["enter"] });
  }

  /**
   * The agent's declared keys for its permission prompt, pressed in the session's pane — only while its screen shows such
   * a prompt, and Allow only with yes under the cursor: the keys answer whatever is on the screen.
   */
  async answer(projectId: string, sessionId: string, which: "allow" | "deny"): Promise<AnswerResult> {
    const s = this.live(projectId, sessionId);
    const terminals = this.terminals();
    const keys = s ? this.approvalOf(s.agent)?.[which] : undefined;
    if (!s?.herdrPane || !terminals?.sendInput || !keys?.length) return "failed";
    const prompt = promptOnScreen((await terminals.readTail(s.herdrPane, PROMPT_LINES).catch(() => null)) ?? "");
    if (!prompt || (which === "allow" && !prompt.allows)) return "notPrompt";
    for (const input of inputsOf(keys)) if (!(await terminals.sendInput(s.herdrPane, input))) return "failed";
    return "answered";
  }

  /**
   * What the session lists show of these sessions' panes: for one waiting on a permission its agent declared the keys
   * for, the prompt on its screen, read once per event and never for a session that waits on nothing.
   */
  async glance(sessions: SessionView[], now = Date.now()): Promise<Map<string, SessionGlance>> {
    const terminals = this.terminals();
    const out = new Map<string, SessionGlance>();
    await Promise.all(
      sessions.map(async (s) => {
        const approval = !!this.approvalOf(s.agent);
        if (!approval || !terminals || !s.herdrPane || s.state !== "waiting" || !APPROVAL_ASK.test(s.activity ?? "")) {
          this.seen.delete(s.id);
          out.set(s.id, { approval, prompt: null });
          return;
        }
        const known = this.seen.get(s.id);
        if (known && known.event === s.lastEventAt && (known.prompt || now - known.at < GLANCE_RECHECK_MS)) return void out.set(s.id, { approval, prompt: known.prompt });
        const seen = promptOnScreen((await terminals.readTail(s.herdrPane, PROMPT_LINES).catch(() => null)) ?? "");
        const prompt = seen ? (seen.allows ? "allow" : "deny") : null;
        this.seen.set(s.id, { event: s.lastEventAt, at: now, prompt });
        out.set(s.id, { approval, prompt });
      })
    );
    return out;
  }

  /** The last lines on the session's pane; null without a pane, or when it is gone. */
  async tail(projectId: string, sessionId: string, lines: number): Promise<string | null> {
    const s = this.store.session(projectId, sessionId);
    const terminals = this.terminals();
    if (!s?.herdrPane || !terminals) return null;
    return terminals.readTail(s.herdrPane, Math.min(TAIL_MAX, Math.max(1, Math.round(lines) || 1)));
  }
}
