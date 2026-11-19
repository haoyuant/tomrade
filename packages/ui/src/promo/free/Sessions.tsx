import type { CSSProperties } from "react";
import { Mark } from "~/code-sessions/cards";
import { say } from "~/lib/dicts";
import { spanLabel } from "~/lib/sessionTime";
import type { Lang } from "../words";

/** The session bar at its own width, in its own pixels. */
export const SIDE = { w: 280 };

/** One session in the bar: its ticket and agent, where it shows, and where it stands. */
export interface SessionCard {
  key: string; title: string; agent: string; /** The cell that shows it; none for one in a terminal no cell has open. */ cell?: number;
  status: "run" | "wait" | "done"; /** How long it has run or waited. */ minutes: number;
  /** What it stopped to ask, as the app words it (`askOf`): its card says so and answers in place. */ asks?: string; /** What it is doing now. */ doing?: string;
  /** A plain shell: no ticket and no agent, only the folder it is in. */ cwd?: string;
  /** The cell that shows it is the selected one. */ current?: boolean; /** 1 as it comes to need the person, down to 0. */ flash?: number; /** Allow under a click: its size. */ press?: number;
}

/** What a session asks, in the app's own words: the command it would run, or the file it would change. */
export const askOf = (lang: Lang, action: "run" | "edit", detail: string): string => say(lang, action === "run" ? "sessionBar.askRun" : "sessionBar.askEdit", { detail });

/**
 * The session bar of Tomrade's Terminal window, in the markup its own Sidebar draws (code-sessions/Sidebar.tsx): the
 * head with how many wait for the person, and a card for each session that says where it is and what it waits with.
 * A card that waits on a permission carries Allow and Look first, as the app's does; `data-cursor="allow"` is on Allow.
 */
export function Sessions({ lang, rows, style, className }: { lang: Lang; rows: SessionCard[]; style?: CSSProperties; className?: string }) {
  const waiting = rows.filter((row) => row.status === "wait").length;
  const words = (key: "domain.time_minutes" | "domain.time_hours", vars?: Record<string, string | number>) => say(lang, key, vars);
  return (
    <aside className={`cs-side film-side${className ? ` ${className}` : ""}`} data-mode="cards" style={style}>
      <div className="cs-bar-head">
        <button type="button" className="icon-btn cs-fold">»</button>
        <span className="cs-bar-title">{say(lang, "codeSessions.bar")}</span>
        {waiting > 0 && <span className="cs-waiting"><Mark status="wait" size={8} />{waiting}</span>}
        <button type="button" className="link-btn side-add">+ {say(lang, "codeSessions.newTerminal")}</button>
      </div>
      <ul className="cs-list">
        {rows.map((row) => {
          const d = spanLabel(row.minutes * 60_000, words);
          const when = row.status === "wait" ? say(lang, "codeSessions.waitingFor", { d }) : row.status === "run" ? say(lang, "codeSessions.runningFor", { d }) : say(lang, "codeSessions.ended");
          const asked = row.status === "wait" && row.asks;
          if (row.cwd !== undefined) {
            return (
              <li key={row.key}>
                <div className="cs-card">
                  <button type="button" className="cs-row" data-status="idle" data-active={row.cell ? true : undefined}>
                    <span className="cs-row-head">
                      <span className="cs-row-name mono">{row.key}</span>
                      <span className="cs-where">{row.cell ? say(lang, "codeSessions.whereCell", { n: row.cell }) : say(lang, "codeSessions.terminal")}</span>
                    </span>
                    <span className="cs-row-meta mono">{row.cwd}</span>
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={row.key}>
              <div className="cs-card" style={{ ["--flash" as string]: row.flash ?? 0 }}>
                <button type="button" className="cs-row" data-status={row.status} data-needs={row.status === "wait" || undefined} data-active={row.cell ? true : undefined} data-ended={row.status === "done" || undefined} aria-current={row.current ? "true" : undefined}>
                  <span className="cs-row-head">
                    <span className="cs-row-name mono"><Mark status={row.status} />{row.key}</span>
                    <span className="cs-where">{row.cell ? say(lang, "codeSessions.whereCell", { n: row.cell }) : say(lang, "codeSessions.terminal")}</span>
                  </span>
                  <span className="cs-row-title">{row.title}</span>
                  <span className="cs-row-meta">{row.agent} · {when}</span>
                  {asked ? <span className="cs-row-wait">{asked}</span> : row.status === "run" && row.doing ? <span className="cs-row-activity">{row.doing}</span> : null}
                </button>
                {asked && (
                  <span className="cs-row-actions" role="group">
                    <button type="button" className="btn btn-primary btn-xs" data-cursor="allow" style={row.press === undefined ? undefined : { transform: `scale(${row.press})` }}>{say(lang, "codeSessions.allow")}</button>
                    <button type="button" className="btn btn-secondary btn-xs">{say(lang, "codeSessions.lookFirst")}</button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
