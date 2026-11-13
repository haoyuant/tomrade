import { say } from "~/lib/dicts";
import { film } from "../Film";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { Ask } from "../Window";
import { CELL, Cell } from "./Cell";
import { Ready } from "./Ready";
import { W, WAITED, WALL_POINTER, WALL_SECONDS, wallCues } from "./scripts";
import { CAPTIONS, PANES, WAIT } from "./words";

const two = (n: number): string => String(n).padStart(2, "0");
const clockOf = (seconds: number): string => `${two(Math.floor(seconds / 60))}:${two(Math.floor(seconds % 60))}`;
/** The stray terminal: its middle and width before, and the pane it becomes. */
const STRAY = { x: 1400, y: 560, w: 760 };
const PANE = { x: 560, y: 650, k: 2.15 };
/** The windows the person was in instead: each one's box, and when it slides over the terminal. */
const OVER: { x: number; y: number; w: number; h: number; at: number; from: [number, number] }[] = [
  { x: 1180, y: 470, w: 640, h: 430, at: W.covered, from: [700, 120] },
  { x: 1010, y: 610, w: 560, h: 380, at: W.covered + 0.7, from: [-200, 640] }
];

/**
 * "An agent asked. You didn't see it. 47 minutes, wasted.": a question waits in a terminal behind the windows the
 * person is in; in Tomrade the pane and the status bar say at once that it waits, and one click sends it on.
 */
export const waiting = film<true>({
  id: "waiting",
  seconds: WALL_SECONDS,
  poster: 3.6,
  formats: ["wide"],
  day: () => 0,
  rise: (t) => 0.12 + 0.8 * ease.inOut(span(t, W.end - 0.2, W.end + 1.6)),
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const words = CAPTIONS[lang];
    const wait = WAIT[lang];
    const hook = lang === "zh" ? 104 : 92;
    const leave = ease.in(span(t, W.end - 0.1, W.end + 0.45));
    const turn = ease.inOut(span(t, W.turn, W.turn + 0.8));
    // The minutes go by faster and faster while nobody looks.
    const unseen = ease.in(span(t, 0.5, 3.5)) * WAITED.unseen;
    const answered = t >= W.answered;
    const seen = Math.min(WAITED.seen, Math.max(0, (t - W.told) / (W.answered - W.told)) * WAITED.seen);
    const after = wait.after.filter((_, i) => t >= W.answered + 0.05 + i * 0.45);
    const caption = { lang, x: WIDE.caption.x, y: WIDE.caption.y, size: WIDE.caption.size, width: WIDE.caption.width, flat: true };
    const side = { left: 1060, transformOrigin: "0 0" };
    const saved = ease.outQuint(span(t, W.saved, W.saved + 0.5));
    return (
      <>
        {/* before: a terminal with a question, under the windows the person is in */}
        {t < W.turn + 0.9 && (
          <>
            <div className="film-pane" style={{
              left: lerp(STRAY.x, PANE.x, turn) - STRAY.w / 2, top: lerp(STRAY.y, PANE.y, turn) - STRAY.w * 0.18, width: STRAY.w, height: STRAY.w * 0.36, fontSize: STRAY.w / 36, zIndex: 3,
              opacity: 1 - span(turn, 0.3, 0.7), transform: `scale(${lerp(1, (CELL.w * PANE.k) / STRAY.w, turn)})`
            }}>
              <div className="film-pane-head"><i className="film-pane-dot is-quiet" /><span>codex · ~/paperplane</span></div>
              <div className="film-pane-log">{wait.before.map((row) => <div key={row}><b>✓</b>{row}</div>)}</div>
              <div className="film-pane-ask">{wait.prompt}<i className="film-pane-caret" style={{ opacity: Math.floor(t * 2.4) % 2 ? 1 : 0 }} /></div>
            </div>
            {OVER.map((box, i) => {
              const on = ease.outQuint(span(t, box.at, box.at + 0.6)) * (1 - ease.in(span(t, W.turn - 0.1, W.turn + 0.35)));
              return (
                <div className="film-other" key={i} style={{ left: lerp(box.x + box.from[0], box.x, on), top: lerp(box.y + box.from[1], box.y, on), width: box.w, height: box.h, opacity: clamp(on * 2), zIndex: 4 + i }}>
                  <div className="film-other-bar"><span className="film-lights" aria-hidden="true"><i /><i /><i /></span></div>
                  {[0.72, 0.9, 0.56, 0.8, 0.64, 0.86].map((width, row) => <i className="film-other-row" key={row} style={{ width: `${width * 100}%` }} />)}
                </div>
              );
            })}
            <div className="film-waited" style={{ left: 1130, top: 196, opacity: clamp(span(t, 0.4, 0.8)) * (1 - span(t, W.turn - 0.1, W.turn + 0.3)) }}>
              <span>{wait.waited}</span><b className="num">{clockOf(unseen)}</b>
            </div>
          </>
        )}
        <Caption t={t} at={-1.5} until={W.turn + 0.1} text={words.wait1} lang={lang} x={122} y={322} size={hook} width={1000} />
        <Caption t={t} at={1.5} until={W.turn + 0.1} text={words.wait2} lang={lang} x={122} y={322 + hook * 1.1} size={hook} width={1000} />
        <Caption t={t} at={2.6} until={W.turn + 0.1} text={words.wait3} lang={lang} x={122} y={322 + hook * 2.2} size={hook} width={1000} />

        {/* with Tomrade: the same terminal as a pane that says it needs the person */}
        {t >= W.turn && leave < 1 && (
          <div className="film-free" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 140}px, 0) scale(${1 - 0.04 * leave})` }}>
            <div className="film-cell-spot" style={{ left: PANE.x, top: PANE.y, opacity: span(turn, 0.3, 0.7), transform: `translate(-50%, -50%) scale(${PANE.k})`, ["--flash" as string]: t >= W.told ? 1 - span(t, W.told, W.told + 0.9) : 0 }}>
              <Cell lang={lang} no={2} pane={PANES[lang][1]} state={t >= W.told && !answered ? "needs" : "running"} style={{ width: CELL.w, height: CELL.h }}>
                {wait.before.map((row) => <div className="film-term-line" key={row}><b>⏺</b>{row}</div>)}
                <div className="film-term-line is-typed">{wait.prompt}{answered ? " y" : ""}{!answered && <i className="film-pane-caret" style={{ opacity: Math.floor(t * 2.4) % 2 ? 1 : 0 }} />}</div>
                {after.map((row, i) => <div className={`film-term-line${i === 0 || i === 2 ? " is-good" : ""}`} key={row}><b>{i === 0 || i === 2 ? "✓" : "⏺"}</b>{row}</div>)}
              </Cell>
            </div>
            {/* the status bar's own line: how many wait for the person */}
            {t >= W.told && (
              <footer className="statusbar film-strip" style={{ ...side, top: 392, opacity: clamp(span(t, W.told, W.told + 0.25)), transform: `scale(${2.4 * (0.94 + 0.06 * ease.back(span(t, W.told, W.told + 0.4)))})` }}>
                <span className="status-item"><span className="live-dot" />MCP <span className="num">127.0.0.1:19090</span></span>
                {answered
                  ? <span className="status-item">{say(lang, "waitQueue.none")}</span>
                  : <span className="status-item status-link status-needs" data-cursor="needs"><span className="needs-dot" aria-hidden="true" /> {say(lang, "statusBar.needsYou", { n: 1 })}</span>}
              </footer>
            )}
            {t >= W.open && t <= W.answered + 0.4 && (
              <div className="film-ask-big" style={{ ...side, top: 506 }}>
                <Ask lang={lang} question={wait.question} show={ease.back(span(t, W.open, W.open + 0.4)) * (1 - ease.in(span(t, W.answered + 0.08, W.answered + 0.3)))} picked={t >= W.picked} x={0} y={0} />
              </div>
            )}
            <div className={`film-waited is-side${answered ? " is-done" : ""}`} style={{ left: 1060, top: lerp(820, 560, ease.inOut(span(t, W.answered + 0.3, W.answered + 0.9))), opacity: clamp(span(t, W.told + 0.1, W.told + 0.4)) }}>
              <span>{wait.waited}</span><b className="num">{clockOf(seen)}</b>
              <s className="num" style={{ opacity: saved, transform: `translate3d(${(1 - saved) * 30}px, 0, 0)` }}>{clockOf(WAITED.unseen)}</s>
            </div>
          </div>
        )}
        <Caption t={t} at={W.turn + 0.4} until={W.open + 0.5} text={words.told} {...caption} />
        <Caption t={t} at={W.open + 0.6} until={W.saved - 0.1} text={words.click} {...caption} />
        <Caption t={t} at={W.saved} until={W.end} text={words.saved} {...caption} />
        <End d={t - W.end} f={WIDE} lang={lang} />
      </>
    );
  },
  pointer: WALL_POINTER,
  cues: wallCues
});
