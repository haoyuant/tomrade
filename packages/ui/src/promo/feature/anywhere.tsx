import type { CSSProperties } from "react";
import { Eyebrow, FoldChevronSpace } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import { Cell } from "../free/Cell";
import type { Plan } from "../sim";
import { clamp, ease, span } from "../time";
import { TicketCard } from "../Window";
import type { Lang } from "../words";
import { Put, Sheet, Ticket, feature, pop } from "./kit";
import { MOMENTS, step } from "./scripts";
import { ANYWHERE_WORDS } from "./words";

const [CELL_AT, TERM_AT, EDITOR_AT, CLAIMED, MOVED, OPENED, ...ROWS] = MOMENTS.anywhere.lands;
const DELIVERED = ROWS[3];
/** A place's box, in its own pixels. */
const BOX = { w: 380, h: 210 };

/**
 * Somewhere an agent works: a cell of Tomrade's Terminal window in its own markup, a window of another terminal app,
 * or an editor with its agent beside the code. The last two are other people's programs, drawn plainly.
 */
function Place({ lang, n, lines, style }: { lang: Lang; n: number; /** How many of its lines are written. */ lines: number; style?: CSSProperties }) {
  const words = ANYWHERE_WORDS[lang];
  const place = words.places[n];
  const rows = place.lines.slice(0, lines);
  if (n === 0) {
    return (
      <Cell lang={lang} no={1} pane={{ key: words.ticket[0], agent: place.agent, title: "" }} state="running" style={{ width: BOX.w, height: BOX.h, ...style }}>
        {rows.map((line) => <div className="film-term-line" key={line}><b>⏺</b>{line.startsWith("tomrade") ? <><em>tomrade</em>{line.slice(7)}</> : line}</div>)}
      </Cell>
    );
  }
  if (n === 1) {
    return (
      <div className="film-pane feat-place" style={{ width: BOX.w, height: BOX.h, ...style }}>
        <div className="film-pane-head"><i className="film-pane-dot is-running" /><span>{place.name} — codex · ~/paperplane</span></div>
        <div className="film-pane-log">{rows.map((line) => <div key={line}><b>⏺</b>{line}</div>)}</div>
      </div>
    );
  }
  return (
    <div className="feat-editor feat-place" style={{ width: BOX.w, height: BOX.h, ...style }}>
      <div className="feat-editor-bar"><span className="film-lights" aria-hidden="true"><i /><i /><i /></span><span>{place.name} — paperplane</span></div>
      <div className="feat-editor-body">
        <div className="feat-editor-code">{[0.7, 0.9, 0.5, 0.82, 0.6, 0.74, 0.44].map((width, row) => <i key={row} style={{ width: `${width * 100}%`, marginLeft: row % 3 ? 12 : 0 }} />)}</div>
        <div className="feat-editor-agent">{rows.map((line) => <div key={line}><b>⏺</b>{line}</div>)}</div>
      </div>
    </div>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = ANYWHERE_WORDS[lang];
  const [key, title, label] = words.ticket;
  if (index === 0) {
    const at = [CELL_AT, TERM_AT, EDITOR_AT];
    const k = 1.46;
    const x = (n: number) => 110 + n * 573;
    const card = { x: 564, y: 800, k: 2.4 };
    return (
      <>
        {/* each place holds the same ticket: a line from it to the card */}
        <svg className="feat-ties" width="1920" height="1080" aria-hidden="true">
          {at.map((land, n) => {
            const from = x(n) + (BOX.w * k) / 2;
            const drawn = ease.inOut(span(q, Math.max(land + 1.6, step(0) + 5.6), Math.max(land + 1.6, step(0) + 5.6) + 0.7));
            return <path key={n} d={`M${from},676 C${from},${740} ${card.x + 396},${card.y - 70} ${card.x + 396},${card.y - 6}`} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - drawn} />;
          })}
        </svg>
        {at.map((land, n) => (
          <div key={n}>
            <Put x={x(n)} y={246} k={k * pop(q, land)}><Place lang={lang} n={n} lines={Math.floor(clamp((q - land - 0.3) / 0.45, 0, 3))} /></Put>
            <div className="feat-place-name" style={{ left: x(n), top: 572, opacity: clamp((q - land - 0.2) * 4) }}>
              <b>{words.places[n].name}</b><span>{n === 2 ? `MCP · ${words.places[n].at}` : `${words.places[n].agent} · ${words.places[n].at}`}</span>
            </div>
          </div>
        ))}
        {/* the one ticket all three took up */}
        <Put x={card.x} y={card.y} w={330} k={card.k * pop(u, 5.4)}><Ticket id={key} title={title} label={label} lang={lang} /></Put>
      </>
    );
  }
  if (index === 1) {
    const stage = [CLAIMED, MOVED, OPENED].filter((land) => q >= land).length;
    const variant = (["todo", "doing", "doing", "verifying"] as const)[stage];
    const column = ["todo", "doing", "verifying"].indexOf(variant);
    const moved = [OPENED, MOVED, CLAIMED].find((land) => q >= land) ?? -9;
    const slid = stage === 0 ? 0 : stage < 3 ? ease.inOut(span(q, CLAIMED, CLAIMED + 0.5)) : 1 + ease.inOut(span(q, OPENED, OPENED + 0.5));
    const plan: Plan = { key, agent: stage === 2 ? "Codex" : "Claude Code", priority: 2, start: variant, pr: 232, moves: [], written: true };
    const minutes = stage === 2 ? 8 : 12;
    return (
      <>
        <div className="feat-rail" style={{ left: 110, top: 232 }}>{words.rail.map((name, n) => <span key={name} className={n === column ? "is-here" : undefined}>{name}</span>)}</div>
        <Put x={110 + 560 * slid} y={322} w={330} k={1.62 * (1 + 0.06 * Math.sin(Math.PI * span(q, moved, moved + 0.5)))}>
          <TicketCard plan={plan} words={{ title, label }} variant={variant} t={0} lang={lang} clock={(at) => (at < 0 ? 600 - minutes : 600)} age={3} where={stage === 2 ? words.places[1].name : undefined} />
        </Put>
        {/* the place at work is lit; the board's card says the same without anyone telling it */}
        {[0, 1, 2].map((n) => {
          const on = stage === n + 1;
          return (
            <Put key={n} x={110 + n * 560} y={540} k={1.35} style={{ opacity: on ? 1 : 0.5 }}>
              <Place lang={lang} n={n} lines={stage > n ? 3 : 0} style={on ? { boxShadow: "0 0 0 3px var(--accent)" } : undefined} />
            </Put>
          );
        })}
        <p className="feat-note" style={{ left: 110, top: 880, maxWidth: 1700, opacity: clamp((u - 1) * 3) }}>{words.note}</p>
      </>
    );
  }
  const shown = ROWS.slice(0, 3).filter((land) => q >= land).length;
  const delivered = q >= DELIVERED;
  const place = (n: number) => (n === 0 ? say(lang, "codeLink.timelinePlace_cell") : n === 1 ? words.places[1].name : say(lang, "codeLink.timelinePlace_terminal"));
  return (
    <>
      {/* the ticket's own page (components/issue/TicketSessions.tsx): what it delivered, then its sessions by when each began */}
      <Sheet x={110} y={232} w={720} k={2.3} show={pop(u, 0)}>
        <div className="feat-head">
          <span className="card-id">{key}</span>
          <strong className="feat-title">{title}</strong>
        </div>
        <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{say(lang, "codeLink.timelineHead")}</Eyebrow>
        <div className="ticket-sessions">
          <p className="meta-txt ticket-delivered" style={{ opacity: delivered ? 1 : 0, color: "var(--fg)", transform: `scale(${delivered ? 1 + 0.04 * Math.sin(Math.PI * span(q, DELIVERED, DELIVERED + 0.6)) : 1})`, transformOrigin: "0 50%" }}>
            <span>{say(lang, "codeLink.deliveredHead")}</span>{" "}
            <a>{say(lang, "codeLink.deliveredPr_merged", { n: 232 })}</a>{" · "}
            {say(lang, "codeLink.deliveredCommits", { n: 8, sessions: 3 })}{" · "}{say(lang, "codeLink.deliveredFiles", { n: 9 })}
          </p>
          <ul className="ticket-timeline">
            {words.sessions.slice(0, shown).map((one, n) => (
              <li key={one.when} className="ticket-timeline-row" style={{ transform: `scale(${pop(q, ROWS[n])})`, transformOrigin: "0 50%" }}>
                <FoldChevronSpace />
                <div className="ticket-timeline-body">
                  <span className="meta-txt dense">{[words.places[n].agent, one.when, place(n)].join(" · ")}</span>
                  <span className="ticket-timeline-outcome">{one.outcome}</span>
                  <span className="meta-txt dense">{[say(lang, "codeLink.timelineCommits", { n: one.commits }), one.asked ? say(lang, "codeLink.timelineAsked", { n: one.asked }) : null].filter(Boolean).join(" · ")}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Sheet>
    </>
  );
}

/** "Do the work wherever you like. Tomrade keeps the books." */
export const anywhere = feature({ id: "anywhere", poster: step(2) + 6, words: ANYWHERE_WORDS, Scene });
