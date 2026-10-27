import type { SessionRow, ThreadRow } from "@tomradex/code-sessions";
import { tailLines } from "../lib/terminalSession";
import { Mark, RowActions, rowAgent, rowName, rowSaid, rowTitle, statusWord, whereOf } from "./cards";
import { paneOf, statusOf, type HereRow } from "./lists";
import { useSay, useWords } from "./say";

/** How many of a pane's last lines a card shows. */
const TAIL_SHOWN = 4;

/**
 * Every session as one big card, in the bar's order: what it is doing — its pane's last lines, the question it waits
 * with, or what came of it — and what can be done from here. "See in a pane" goes back to the cells on it.
 */
export function Overview({ rows, tails, active, cells, onSee, onThread, onAnswer, onAnswerThread }: { rows: HereRow[]; tails: Record<string, string | null>; active: Set<string>; cells: Map<string, number>; onSee: (row: HereRow) => void; onThread: (thread: ThreadRow) => void; onAnswer: (session: SessionRow, which: "allow" | "deny") => void; onAnswerThread: (thread: ThreadRow, questionId: string, value: string) => void }) {
  const say = useSay();
  const words = useWords();
  return (
    <div className="cs-overview" data-testid="cs-overview" role="region" aria-label={say("viewOverview")}>
      {rows.length ? (
        rows.map((r) => {
          const status = statusOf(r);
          const pane = paneOf(r);
          const lines = status === "done" ? [] : tailLines(pane ? tails[pane] : null, TAIL_SHOWN);
          const said = rowSaid(r, status, say, words);
          const name = rowName(r, say);
          const title = rowTitle(r, say);
          const inCell = active.has(r.id) || (!!r.session && active.has(r.session.id));
          const cell = cells.get(r.id) ?? (r.session ? cells.get(r.session.id) : undefined) ?? null;
          return (
            <section key={r.id} className="cs-big" data-testid="cs-big" data-status={status} aria-current={inCell || undefined} aria-label={name}>
              <span className="cs-big-head">
                <Mark status={status} />
                <span className="cs-big-name">
                  <span className="mono">{name}</span>
                  {title && <span className="cs-big-title">{title}</span>}
                </span>
                <span className="cs-row-meta">{[rowAgent(r), whereOf(r, cell, say), statusWord(status, say)].filter(Boolean).join(" · ")}</span>
              </span>
              {said && status === "done" && <span className="cs-row-outcome">{say("outcome", { text: said })}</span>}
              {said && status === "wait" && <span className="cs-row-wait">{said}</span>}
              {lines.length ? (
                <pre className="cs-big-tail" data-testid="cs-big-tail" aria-label={say("paneTail")}>
                  {lines.join("\n")}
                </pre>
              ) : (
                said && status !== "done" && status !== "wait" && <span className="cs-row-activity">{said}</span>
              )}
              <RowActions row={r} big onSee={onSee} onThread={onThread} onAnswer={onAnswer} onAnswerThread={onAnswerThread} />
            </section>
          );
        })
      ) : (
        <p className="cs-empty">{say("overviewEmpty")}</p>
      )}
    </div>
  );
}
