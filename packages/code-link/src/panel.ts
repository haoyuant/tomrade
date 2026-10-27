import type { Context } from "cordis";
import type { EngineApproval } from "@tomradex/agent";
import type { TerminalInput } from "@tomradex/contracts";
import type { CodeLinkStore, SessionView } from "./store.js";

/** The most of a pane's screen one read of its tail takes. */
const TAIL_MAX = 200;
/** How many of a pane's last lines are read for the prompt Allow or Deny would answer. */
const PROMPT_LINES = 30;

/** What answering a session's permission prompt came to: answered, nothing pressed for a screen that asks no such thing, or failed. */
export type AnswerResult = "answered" | "notPrompt" | "failed";

// The box edges an agent draws its prompt in.
const EDGE = /^[\s│┃║|]+|[\s│┃║|]+$/g;
/** The question asked before a tool runs: "Do you want to proceed?", "Allow command?", "Would you like to run the following command?". */
const ASKS = /(?:\b(?:do you want|would you like|allow|approve|proceed|permission|run)\b|允许|批准|执行).*[?？]$/i;
/** A folder's trust is not a tool's permission, and Enter there may well be "No, exit". */
const TRUST = /\btrust|信任/i;
/** An option: the cursor's mark, a number, or both, before its words. */
const OPTION = /^(?:([❯›▶➤>●])\s*)?(?:(\d+)[.)]\s+)?(\S.*)$/;
const YES = /^(?:yes|allow|approve|proceed|accept|always|run|允许|同意|批准|是)/i;
const NO = /^(?:no\b|deny|reject|decline|cancel|don'?t|拒绝|否|不)/i;

/**
 * The permission prompt on a pane's screen, read from its last lines: the option under the cursor, and whether it says
 * yes. Null when the screen asks nothing a key could safely answer: no such question, a folder's trust, or no choice
 * between yes and no under it.
 */
export function promptOnScreen(screen: string): { selected: string; allows: boolean } | null {
  const lines = screen.split("\n").map((l) => l.replace(EDGE, "")).filter(Boolean);
  // a narrow pane wraps the question onto a second line
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (ASKS.test(lines[i]!) || (i > 0 && ASKS.test(`${lines[i - 1]} ${lines[i]}`))) at = i;
  if (at < 0) return null;
  const block = lines.slice(Math.max(0, at - 1));
  if (block.some((l) => TRUST.test(l))) return null;
  let selected: string | null = null;
  let options = 0;
  let saysNo = false;
  for (const line of lines.slice(at + 1)) {
    const [, mark, number, text] = OPTION.exec(line) ?? [];
    if (!text || (!mark && !number)) continue;
    options++;
    if (NO.test(text)) saysNo = true;
    if (mark && selected === null) selected = text;
  }
  if (selected === null || options < 2 || !saysNo) return null;
  return { selected, allows: YES.test(selected) && !NO.test(selected) };
}

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

  /** The last lines on the session's pane; null without a pane, or when it is gone. */
  async tail(projectId: string, sessionId: string, lines: number): Promise<string | null> {
    const s = this.store.session(projectId, sessionId);
    const terminals = this.terminals();
    if (!s?.herdrPane || !terminals) return null;
    return terminals.readTail(s.herdrPane, Math.min(TAIL_MAX, Math.max(1, Math.round(lines) || 1)));
  }
}
