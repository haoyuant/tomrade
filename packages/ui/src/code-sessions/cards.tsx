import type { SessionRow, ThreadRow } from "@tomradex/code-sessions";
import { canAnswer, sessionName, type BarStatus, type HereRow } from "./lists";
import { useSay, type Say } from "./say";

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

/** Where it is: a pane of this window, a terminal here, another app, another computer, Tomrade itself, or the assistant. */
export function whereOf(r: HereRow, inCell: boolean, say: Say): string {
  if (r.kind === "thread") return say("inAssistant");
  if (inCell) return say("whereCell");
  const s = r.session;
  if (r.kind === "terminal" || !s || s.where === "herdr") return say("terminal");
  if (s.where === "tomrade") return say("runMode");
  if (s.where === "elsewhere") return say("elsewhereTag");
  return s.terminal ?? say("outsideTerminal");
}

/** What the card says under its name: the question it waits with, what it is doing now, or what came of it. */
export function rowSaid(r: HereRow, status: BarStatus, say: Say): string | null {
  if (r.kind === "thread") {
    const wait = r.thread.wait;
    if (wait) return wait.text ?? say(wait.kind === "permission" ? "waitPermission" : "waitQuestion");
    return r.session?.activity ?? null;
  }
  const s = r.session;
  if (!s) return null;
  if (status === "wait") return s.activity ?? say("waitPermission");
  return s.activity;
}

/** Said under what a row says: the warning's colour while it waits, the quote of an outcome once it ended, muted otherwise. */
export const saidClass = (status: BarStatus): string => (status === "wait" ? "cs-row-wait" : status === "done" ? "cs-row-outcome" : "cs-row-activity");

/**
 * What can be done from a row without opening it: a permission its agent declared the keys for is allowed or denied
 * here; in the overview, a row with a pane goes to its cell and a conversation to the app window.
 */
export function RowActions({ row, big = false, onSee, onThread, onAnswer }: { row: HereRow; big?: boolean; onSee: (row: HereRow) => void; onThread: (thread: ThreadRow) => void; onAnswer: (session: SessionRow, which: "allow" | "deny") => void }) {
  const say = useSay();
  const s = row.session;
  const answerable = !!s && canAnswer(s);
  const seeable = big && row.kind !== "thread" && !!(row.kind === "terminal" ? row.terminal.pane : s?.pane);
  if (!answerable && !seeable && !(big && row.kind === "thread")) return null;
  return (
    <span className="cs-row-actions" data-testid="cs-row-actions">
      {answerable && (
        <>
          <button type="button" className="btn btn-primary btn-xs" data-testid="cs-allow" onClick={() => onAnswer(s, "allow")}>
            {say("allow")}
          </button>
          <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-deny" onClick={() => onAnswer(s, "deny")}>
            {say("deny")}
          </button>
        </>
      )}
      {seeable && (
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-see-in-pane" onClick={() => onSee(row)}>
          {say("seeInPane")}
        </button>
      )}
      {big && row.kind === "thread" && (
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-open-in-main" onClick={() => onThread(row.thread)}>
          {say("openInMain")}
        </button>
      )}
    </span>
  );
}
