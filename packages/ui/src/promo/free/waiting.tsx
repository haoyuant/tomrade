import { film } from "../Film";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { ease, lerp, span } from "../time";
import { Ask } from "../Window";
import { CELL, Cell, Working, type CellState } from "./Cell";
import { Ready } from "./Ready";
import { W, WALL_POINTER, WALL_SECONDS, wallCues } from "./scripts";
import { CAPTIONS, LOG, PANES, QUESTION } from "./words";

/** The wall: panes in rows and columns, wider than the frame, under the caption band. */
const COLS = 5;
const ROWS = 4;
const GAP = 14;
const K = 1.02;
const TOP = 262;
const spot = (i: number) => ({
  x: WIDE.w / 2 + ((i % COLS) - (COLS - 1) / 2) * (CELL.w * K + GAP),
  y: TOP + (CELL.h * K) / 2 + Math.floor(i / COLS) * (CELL.h * K + GAP)
});
/** The pane that needs the person, and when the others' tickets are done once it has its answer. */
const NEEDY = 7;
const DONE: Record<number, number> = { 1: 7.9, 13: 8.2, 5: 8.5, 9: 8.8, 16: 9.1 };

/** "All of them running. One needs you.": a wall of panes, the one that asks, the answer, and on they go. */
export const waiting = film<true>({
  id: "waiting",
  seconds: WALL_SECONDS,
  poster: 5.2,
  formats: ["wide"],
  day: () => 0,
  rise: (t) => 0.12 + 0.8 * ease.inOut(span(t, W.end - 0.2, W.end + 1.6)),
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const words = CAPTIONS[lang];
    const leave = ease.in(span(t, W.end - 0.1, W.end + 0.45));
    const hero = ease.inOut(span(t, W.zoom, W.zoom + 0.6)) * (1 - ease.inOut(span(t, W.back, W.back + 0.55)));
    const needs = t >= W.need && t < W.answered;
    const caption = { lang, x: WIDE.caption.x, y: WIDE.caption.y, size: WIDE.caption.size, width: WIDE.caption.width, flat: true };
    return (
      <>
        {leave < 1 && (
          <div className="film-free film-wall" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 140}px, 0) scale(${1.0 + 0.035 * span(t, 0, W.end) - 0.04 * leave})` }}>
            {Array.from({ length: COLS * ROWS }, (_, i) => {
              const at = spot(i);
              const mine = i === NEEDY ? hero : 0;
              const pane = { ...PANES[lang][(i * 3) % 5], key: `APP-${41 + ((i * 7) % 20)}` };
              const state: CellState = i === NEEDY && needs ? "needs" : t >= (DONE[i] ?? Infinity) ? "done" : "running";
              return (
                <div className="film-cell-spot" key={i} style={{
                  left: lerp(at.x, 640, mine), top: lerp(at.y, 640, mine), zIndex: i === NEEDY ? 8 : 2, opacity: i === NEEDY ? 1 : 1 - 0.8 * Math.max(hero, span(t, W.need, W.need + 0.5) * (1 - span(t, W.back, W.back + 0.5))),
                  transform: `translate(-50%, -50%) scale(${K * lerp(1, 2.15, mine)})`, ["--flash" as string]: i === NEEDY && t >= W.need ? 1 - span(t, W.need, W.need + 0.9) : 0
                }}>
                  <Cell lang={lang} no={i + 1} pane={pane} state={state} style={{ width: CELL.w, height: CELL.h }}>
                    {i === NEEDY && t >= W.need ? (
                      <>
                        <div className="film-term-line"><b>⏺</b>{LOG[lang].work[0]}</div>
                        <div className="film-term-line"><b>⏺</b>tomrade  ask_user</div>
                        {needs && <div className="film-term-line is-typed">{QUESTION[lang].text}</div>}
                        {t >= W.answered && <div className="film-term-line is-good"><b>✓</b>{QUESTION[lang].options[0]}</div>}
                        {t >= W.answered + 0.5 && <Working lang={lang} t={t} from={W.answered + 0.5} shift={1} most={3} />}
                      </>
                    ) : <Working lang={lang} t={t} from={-3 + (i % 7) * 0.31} pace={0.46 + (i % 5) * 0.09} shift={i * 3} />}
                  </Cell>
                </div>
              );
            })}
            {t >= W.ask && t <= W.answered + 0.4 && (
              <div className="film-ask-big">
                <Ask lang={lang} question={QUESTION[lang]} show={ease.back(span(t, W.ask, W.ask + 0.4)) * (1 - ease.in(span(t, W.answered + 0.08, W.answered + 0.3)))} picked={t >= W.picked} x={0} y={0} />
              </div>
            )}
          </div>
        )}
        <i className="film-wall-fade" aria-hidden="true" style={{ opacity: 1 - leave }} />
        <Caption t={t} at={-1.5} until={W.need - 0.1} text={words.wall1} {...caption} />
        <Caption t={t} at={W.need} until={5.3} text={words.wall2} {...caption} />
        <Caption t={t} at={5.4} until={W.back + 0.1} text={words.wall3} {...caption} />
        <Caption t={t} at={W.back + 0.2} until={W.end} text={words.wall4} {...caption} />
        <End d={t - W.end} f={WIDE} lang={lang} />
      </>
    );
  },
  pointer: WALL_POINTER,
  cues: wallCues
});
