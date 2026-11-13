import type { CSSProperties, ReactNode } from "react";
import { say } from "~/lib/dicts";
import { clamp } from "../time";
import type { Lang } from "../words";
import { LOG } from "./words";

/** A pane of the Terminal window at its own size, in its own pixels. */
export const CELL = { w: 362, h: 228 };
export type CellState = "running" | "needs" | "done";

/**
 * One pane of Tomrade's Terminal window, in the markup its own Cell draws (code-sessions/Cell.tsx): its number, the
 * ticket and agent it runs, the chip that says where it stands, and what its terminal shows.
 */
export function Cell({ lang, no, pane, state, style, children }: {
  lang: Lang; no: number; pane: { key: string; agent: string; title: string }; /** A plain shell has none. */ state?: CellState; style?: CSSProperties; children: ReactNode;
}) {
  return (
    <div className="cs-cell film-cell" data-wait={state === "needs" || undefined} style={style}>
      <div className="cs-cell-bar">
        <span className="cs-cell-no">{no}</span>
        <span className="cs-cell-name">
          {pane.key && <><span className="film-mono">{pane.key}</span>{" "}<span className="cs-cell-agent">{pane.agent}</span>{" "}</>}
          {pane.title}
        </span>
        {state && <span className="tag cs-chip" data-state={state}>{say(lang, state === "needs" ? "codeSessions.needsYou" : `codeSessions.${state}`)}</span>}
        <span className="cs-cell-tools">
          <button type="button" className="icon-btn">⇥</button>
          <button type="button" className="icon-btn">⤓</button>
        </span>
      </div>
      <div className="cs-term film-cell-term">{children}</div>
    </div>
  );
}

/** What a working pane has written by t: a line every `pace` seconds from `from`, the last few of them. */
export function Working({ lang, t, from, pace = 0.62, shift = 0, shell = false, most = 6 }: { lang: Lang; t: number; from: number; pace?: number; /** Where in the log it starts. */ shift?: number; shell?: boolean; most?: number }) {
  const log = shell ? LOG[lang].shell : LOG[lang].work;
  const written = Math.max(0, Math.floor((t - from) / pace) + 1);
  return (
    <>
      {Array.from({ length: Math.min(written, most) }, (_, k) => {
        const i = written - Math.min(written, most) + k;
        const line = log[(i + shift) % log.length];
        const age = t - (from + i * pace);
        return (
          <div className="film-term-line" key={i} style={{ opacity: clamp(age / 0.1) }}>
            {!line.startsWith("$") && !shell && <b>⏺</b>}{line}
          </div>
        );
      })}
    </>
  );
}
