import { createContext, useContext, useSyncExternalStore } from "react";
import type { SessionRow } from "@tomradex/code-sessions";
import { send } from "./bridge";
import { useSay } from "./say";

/** The live sessions on no ticket that have a guess, by the pane they run in: a terminal opened here speaks for its own. */
export const GuessContext = createContext<Map<string, SessionRow>>(new Map());

export const guessesByPane = (sessions: SessionRow[]): Map<string, SessionRow> => new Map(sessions.flatMap((s) => (s.guess && s.pane && s.endedAt === null ? [[s.pane, s] as const] : [])));

/** "What you said sounds like TOM-636", with the two answers: claim it, or go on without a ticket. Nothing without a guess. */
export function Guess({ session, pane, place }: { session: SessionRow | null | undefined; pane: string | null | undefined; place: "card" | "cell" }) {
  const say = useSay();
  const byPane = useContext(GuessContext);
  const s = session?.guess ? session : pane ? byPane.get(pane) : undefined;
  const guess = s?.guess;
  if (!s || !guess) return null;
  return (
    <div className="cs-guess" data-place={place} data-testid="cs-guess" title={guess.title}>
      <span>{say("guessSays", { key: guess.key })}</span>
      <span className="cs-guess-actions">
        <button type="button" className="btn btn-primary btn-xs" data-testid="cs-guess-take" title={say("guessTakeHint", { key: guess.key })} onClick={() => send({ type: "takeGuess", sessionId: s.id })}>
          {say("guessTake", { key: guess.key })}
        </button>
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-guess-none" title={say("guessNoneHint")} onClick={() => send({ type: "noTicket", sessionId: s.id })}>
          {say("guessNone")}
        </button>
      </span>
    </div>
  );
}

const HINT_KEY = "tomrade.codeSessions.shellHint";
const hintListeners = new Set<() => void>();
const hintHidden = (): boolean => {
  try {
    return localStorage.getItem(HINT_KEY) === "hidden";
  } catch {
    return false;
  }
};
const hideHint = () => {
  try {
    localStorage.setItem(HINT_KEY, "hidden");
  } catch {
    // Not kept: it comes back with the next window.
  }
  for (const listener of hintListeners) listener();
};
const onHint = (listener: () => void) => {
  hintListeners.add(listener);
  return () => hintListeners.delete(listener);
};

/** Under a terminal where only its shell runs: an agent started here becomes a session; the button types its command in. Once hidden, it stays hidden. */
export function ShellHint({ cell }: { cell: string }) {
  const say = useSay();
  const hidden = useSyncExternalStore(onHint, hintHidden);
  if (hidden) return null;
  const typeIn = () => {
    send({ type: "input", cell, data: "claude" });
    document.querySelector<HTMLTextAreaElement>(`.cs-cell[data-cell="${cell}"] .xterm-helper-textarea`)?.focus();
  };
  return (
    <div className="cs-shell-hint" data-testid="cs-shell-hint">
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-shell-try" onClick={typeIn}>
        {say("shellTry")}
      </button>
      <span className="cs-shell-note">{say("shellNote")}</span>
      <button type="button" className="icon-btn cs-shell-hide" aria-label={say("shellHide")} title={say("shellHide")} onClick={hideHint}>
        ×
      </button>
    </div>
  );
}
