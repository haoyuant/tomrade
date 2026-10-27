import type { SessionRow, ThreadRow } from "@tomradex/code-sessions";
import { outcomeLine } from "../lib/review";
import { rangeLabel, spanLabel } from "../lib/sessionTime";
import { canAnswer, rowStartedAt, sessionName, waitedSince, type BarStatus, type HereRow } from "./lists";
import { useSay, type Say, type Words } from "./say";

/** Three shapes, the session bar's, so the state reads without colour: a ring runs, a diamond waits, a tick ended. */
export function Mark({ status, size = 10 }: { status: BarStatus; size?: number }) {
  if (status === "wait")
    return (
      <svg className="cs-mark is-wait" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <path d="M5 0 L10 5 L5 10 L0 5 Z" />
      </svg>
    );
  if (status === "run")
    return (
      <svg className="cs-mark is-run" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
        <circle cx="5" cy="5" r="3.6" />
      </svg>
    );
  if (status === "done")
    return (
      <svg className="cs-mark is-done" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 6.5 L5 9 L10 3" />
      </svg>
    );
  return null;
}

/** What a row goes by: its ticket, else what its agent calls the conversation, else what runs in its terminal. */
export const rowName = (r: HereRow, say: Say): string => (r.kind === "thread" ? (r.thread.key ?? (r.thread.title || say("newThread"))) : r.kind === "terminal" && !r.session ? (r.terminal.running ?? r.terminal.title) : sessionName(r.session!));

/** The row's name reads as code: a ticket key, a branch, a command. */
export const rowMono = (r: HereRow): boolean => r.kind !== "thread" || !!r.thread.key;

/** The line under the name: a ticket's title, the conversation's, or the agent's title for a terminal. */
export const rowTitle = (r: HereRow, say: Say): string | null => {
  if (r.kind === "thread") return r.thread.key ? r.thread.title || r.thread.ticketTitle : null;
  if (r.kind === "terminal" && !r.session) return r.terminal.agentTitle;
  const s = r.session!;
  return s.title ?? s.agentTitle ?? (s.itemId ? null : say("noTicket"));
};

export const rowAgent = (r: HereRow): string | null => (r.kind === "thread" ? (r.thread.engineName ?? r.thread.engine) : r.session ? (r.session.agentName ?? r.session.agent) : null);

export const statusWord = (s: BarStatus, say: Say): string => say(s === "wait" ? "needsYou" : s === "run" ? "running" : s === "done" ? "ended" : "idle");

/** Where it is: a cell of this window by its number, a terminal here, another app, another computer, Tomrade itself, or the assistant. */
export function whereOf(r: HereRow, cell: number | null, say: Say): string {
  if (r.kind === "thread") return say("inAssistant");
  if (cell) return say("whereCell", { n: cell });
  const s = r.session;
  if (r.kind === "terminal" || !s || s.where === "herdr") return say("terminal");
  if (s.where === "tomrade") return say("runMode");
  if (s.where === "elsewhere") return say("elsewhereTag");
  return s.terminal ?? say("outsideTerminal");
}

/** What came of an ended session, said the way the assistant panel and the look back say it. */
export const outcomeOf = (s: SessionRow, words: Words): string | null => (s.outcome ? outcomeLine(s.outcome, (key, vars) => words(`review.${key}`, vars)) : s.activity);

/** How long it has run or waited, or when it ran; an idle one says so. */
export function rowWhen(r: HereRow, status: BarStatus, say: Say, words: Words, now = Date.now()): string {
  const span = (ms: number) => spanLabel(ms, words);
  if (status === "run") return say("runningFor", { d: span(now - rowStartedAt(r)) });
  if (status === "wait") return say("waitingFor", { d: span(now - waitedSince(r)) });
  const s = r.session;
  if (status === "done" && s?.endedAt) return say("endedRange", { range: rangeLabel(s.startedAt, s.endedAt) });
  return statusWord(status, say);
}

/** What the card says under its name: the question it waits with, what it is doing now, or what came of it. */
export function rowSaid(r: HereRow, status: BarStatus, say: Say, words: Words): string | null {
  if (r.kind === "thread") {
    const wait = r.thread.wait;
    if (wait) return wait.text ?? say(wait.kind === "permission" ? "waitPermission" : "waitQuestion");
    return r.session?.activity ?? null;
  }
  const s = r.session;
  if (!s) return null;
  if (status === "wait") return s.activity ?? say("waitPermission");
  if (status === "done") return outcomeOf(s, words);
  return s.activity;
}

/** Said under what a row says: the warning's colour while it waits, the quote of an outcome once it ended, muted otherwise. */
export const saidClass = (status: BarStatus): string => (status === "wait" ? "cs-row-wait" : status === "done" ? "cs-row-outcome" : "cs-row-activity");

/** At most this many of a question's choices sit on its card; the rest are answered where it opens. */
const CHOICES_SHOWN = 3;

/**
 * What can be done from a row without opening it. On a card in the bar, what it waits on is answered in place — a
 * permission prompt on its screen that its agent declared the keys for (Allow with yes under the cursor, else Deny), or
 * an assistant question by one of its choices — or looked at first. In the overview, Allow and Deny, and a row with a
 * pane goes to its cell and a conversation to the app window.
 */
export function RowActions({ row, big = false, onSee, onThread, onAnswer, onAnswerThread }: { row: HereRow; big?: boolean; onSee: (row: HereRow) => void; onThread: (thread: ThreadRow) => void; onAnswer: (session: SessionRow, which: "allow" | "deny") => void; onAnswerThread: (thread: ThreadRow, questionId: string, value: string) => void }) {
  const say = useSay();
  const s = row.session;
  const answerable = !!s && canAnswer(s);
  const wait = row.kind === "thread" ? row.thread.wait : null;
  const questionId = wait?.questionId ?? null;
  const choices = questionId && wait?.options ? wait.options.slice(0, CHOICES_SHOWN) : [];
  const seeable = big && row.kind !== "thread" && !!(row.kind === "terminal" ? row.terminal.pane : s?.pane);
  const choiceButtons = row.kind === "thread" && questionId
    ? choices.map((choice, i) => (
        <button key={choice} type="button" className={i === 0 ? "btn btn-primary btn-xs" : "btn btn-secondary btn-xs"} data-testid="cs-choice" onClick={() => onAnswerThread(row.thread, questionId, choice)}>
          {choice}
        </button>
      ))
    : null;
  if (!big) {
    if (!answerable && !choices.length) return null;
    return (
      <span className="cs-row-actions" role="group" aria-label={say("askGroup")} data-testid="cs-row-actions">
        {answerable &&
          (s.prompt === "allow" ? (
            <button type="button" className="btn btn-primary btn-xs" data-testid="cs-allow" onClick={() => onAnswer(s, "allow")}>
              {say("allow")}
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-deny" onClick={() => onAnswer(s, "deny")}>
              {say("deny")}
            </button>
          ))}
        {choiceButtons}
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-look" onClick={() => onSee(row)}>
          {say("lookFirst")}
        </button>
      </span>
    );
  }
  if (!answerable && !seeable && row.kind !== "thread") return null;
  return (
    <span className="cs-row-actions" data-testid="cs-row-actions">
      {answerable && (
        <>
          {s.prompt === "allow" && (
            <button type="button" className="btn btn-primary btn-xs" data-testid="cs-allow" onClick={() => onAnswer(s, "allow")}>
              {say("allow")}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-deny" onClick={() => onAnswer(s, "deny")}>
            {say("deny")}
          </button>
        </>
      )}
      {choiceButtons}
      {seeable && (
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-see-in-pane" onClick={() => onSee(row)}>
          {say("seeInPane")}
        </button>
      )}
      {row.kind === "thread" && (
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-open-in-main" onClick={() => onThread(row.thread)}>
          {say("openInMain")}
        </button>
      )}
    </span>
  );
}
