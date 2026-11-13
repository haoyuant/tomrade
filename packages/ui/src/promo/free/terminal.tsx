import { film } from "../Film";
import { End } from "../Outro";
import { Caption } from "../parts";
import type { Plan } from "../sim";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { TicketCard } from "../Window";
import { CELL, Cell, Working, type CellState } from "./Cell";
import { Ready } from "./Ready";
import { K, PANE_MOVES, PILE_AT, TERMINAL_POINTER, TERMINAL_SECONDS, terminalCues } from "./scripts";
import { CAPTIONS, LOG, PANES } from "./words";

/** The Terminal window on the frame: its box, its bar's height, the gap around its panes and their scale. */
const WIN = { x: 120, y: 250, w: 1680, h: 772, bar: 51, gap: 12, k: 1.5 };
const slot = (i: number) => ({
  x: WIN.x + WIN.gap + (i % 3) * (CELL.w * WIN.k + WIN.gap) + (CELL.w * WIN.k) / 2,
  y: WIN.y + WIN.bar + WIN.gap + Math.floor(i / 3) * (CELL.h * WIN.k + WIN.gap) + (CELL.h * WIN.k) / 2
});
/** The pile: each stray terminal's middle and tilt, and the pane it ends up as. */
const PILE: [number, number, number][] = [[1290, 196, -4], [1650, 262, 3], [1240, 398, 2], [1600, 474, -3], [1370, 590, 5], [1690, 668, -2], [1250, 764, -1.5], [1560, 858, 2.5], [1440, 318, -6]];
const PANE_W = 480;
const INTO = [0, 1, 2, 3, 4, 5, 1, 3, 4];
/** The pane that needs the person. */
const NEEDY = 4;

const plans: Plan[] = PANE_MOVES.slice(0, 5).map(([pr, done], i) => ({
  key: PANES.en[i].key, agent: PANES.en[i].agent as Plan["agent"], priority: 2, start: "doing", pr: 231 + i, written: true,
  moves: [{ at: pr, to: "verifying" as const }, { at: done, to: "done" as const }].filter((move) => Number.isFinite(move.at))
}));
const clock = (t: number): number => 600 + t * 3;
const stateOf = (i: number, t: number): CellState | undefined => (i === 5 ? undefined : i === NEEDY && t >= K.need && t < K.typed + 0.25 ? "needs" : t >= PANE_MOVES[i][1] ? "done" : "running");

/**
 * "Terminals pile up. Which one needs you?": stray terminals snap into the panes of Tomrade's Terminal window, where
 * each says whether it runs or needs the person, knows its ticket, and works on while the app is closed.
 */
export const terminal = film<true>({
  id: "terminal",
  shelf: "3-features/terminal",
  seconds: TERMINAL_SECONDS,
  poster: 7.6,
  formats: ["wide"],
  day: () => 0,
  rise: (t) => 0.12 + 0.8 * ease.inOut(span(t, K.end - 0.2, K.end + 1.6)),
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const words = CAPTIONS[lang];
    const hook = lang === "zh" ? 116 : 96;
    const leave = ease.in(span(t, K.end - 0.1, K.end + 0.45));
    // The app closed: its window and tickets all but gone, the panes' own writing still coming.
    const closed = ease.inOut(span(t, K.quit + 0.1, K.quit + 0.7)) * (1 - ease.inOut(span(t, K.reopen, K.reopen + 0.6)));
    const hero = ease.inOut(span(t, K.zoom, K.zoom + 0.55)) * (1 - ease.inOut(span(t, K.back, K.back + 0.5)));
    const framed = ease.out(span(t, K.snap + 0.25, K.snap + 0.85));
    return (
      <>
        {t < K.snap + 1.4 && PILE.map(([x, y, tilt], n) => {
          if (t < PILE_AT[n]) return null;
          const e = ease.inOut(span(t, K.snap + n * 0.04, K.snap + 0.75 + n * 0.04));
          const to = slot(INTO[n]);
          const land = ease.back(span(t, PILE_AT[n], PILE_AT[n] + 0.4));
          const asks = n === 3;
          return (
            <div className="film-pane" key={n} style={{
              left: lerp(x, to.x, e) - PANE_W / 2, top: lerp(y, to.y, e) - PANE_W * 0.18 + (1 - land) * 50, width: PANE_W, height: PANE_W * 0.36, fontSize: PANE_W / 36, zIndex: 3 + n,
              opacity: clamp(span(t, PILE_AT[n], PILE_AT[n] + 0.1)) * (1 - span(e, 0.3, 0.7)), transform: `rotate(${lerp(tilt, 0, e)}deg) scale(${lerp(0.84 + 0.16 * land, (CELL.w * WIN.k) / PANE_W, e)})`
            }}>
              <div className="film-pane-head"><i className="film-pane-dot is-quiet" /><span>{LOG[lang].untitled[n]}</span></div>
              <div className="film-pane-log">{LOG[lang].work.slice(n % 4, (n % 4) + 2).map((row) => <div key={row}><b>✓</b>{row}</div>)}</div>
              <div className="film-pane-ask">{asks ? LOG[lang].ask : "$"}<i className="film-pane-caret" style={{ opacity: Math.floor(t * 2.4 + n) % 2 ? 1 : 0 }} /></div>
            </div>
          );
        })}
        <Caption t={t} at={-1.5} until={K.snap + 0.12} text={words.pile1} lang={lang} x={122} y={322} size={hook} width={1700} />
        <Caption t={t} at={1.3} until={K.snap + 0.12} text={words.pile2} lang={lang} x={122} y={322 + hook * 1.1} size={hook} width={1700} />
        <Caption t={t} at={2.4} until={K.snap + 0.12} text={words.pile3} lang={lang} x={122} y={322 + hook * 2.2} size={hook} width={1700} />

        {t >= K.snap && leave < 1 && (
          <div className="film-free" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 140}px, 0) scale(${1 - 0.04 * leave})` }}>
            <div className="film-termwin" style={{ left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, opacity: framed * (1 - 0.9 * closed), transform: `scale(${0.97 + 0.03 * framed})` }}>
              <div className="film-termwin-bar" style={{ height: WIN.bar }}>
                <span className="film-lights" aria-hidden="true"><i data-cursor="close" /><i /><i /></span>
                <span className="cs-project">{LOG[lang].window}</span>
              </div>
            </div>
            {PANES[lang].map((pane, i) => {
              const at = slot(i);
              const e = ease.inOut(span(t, K.snap + i * 0.04, K.snap + 0.75 + i * 0.04));
              const mine = i === NEEDY ? hero : 0;
              const state = stateOf(i, t);
              const waiting = i === NEEDY && t >= K.need && t < K.typed + 0.25;
              const flash = i === NEEDY && t >= K.need ? 1 - span(t, K.need, K.need + 0.9) : 0;
              return (
                <div className="film-cell-spot" key={i} style={{
                  left: lerp(at.x, 960, mine), top: lerp(at.y, 640, mine), zIndex: mine > 0 ? 8 : 2, opacity: span(e, 0.3, 0.7) * (1 - 0.72 * (i === NEEDY ? 0 : hero)),
                  transform: `translate(-50%, -50%) scale(${WIN.k * lerp(1, 1.75, mine)})`, ["--ghost" as string]: closed, ["--flash" as string]: flash
                }}>
                  <Cell lang={lang} no={i + 1} pane={pane} state={state} style={{ width: CELL.w, height: CELL.h }}>
                    {i === NEEDY && t >= K.need ? (
                      <>
                        <div className="film-term-line"><b>⏺</b>{LOG[lang].work[0]}</div>
                        <div className="film-term-line is-typed">{LOG[lang].ask}{t >= K.typed ? " y" : ""}{waiting && <i className="film-pane-caret" style={{ opacity: Math.floor(t * 2.6) % 2 ? 1 : 0 }} />}</div>
                        {t >= K.typed + 0.25 && <div className="film-term-line is-good"><b>✓</b>{LOG[lang].answered}</div>}
                        {t >= K.typed + 0.8 && <Working lang={lang} t={t} from={K.typed + 0.8} shift={2} most={3} />}
                      </>
                    ) : <Working lang={lang} t={t} from={K.snap - 2.4 + i * 0.17} pace={0.5 + (i % 3) * 0.11} shift={i === 5 ? 0 : i * 3} shell={i === 5} />}
                  </Cell>
                </div>
              );
            })}
            {t >= K.ticket && plans.map((plan, i) => {
              const at = slot(i);
              const e = ease.back(span(t, K.ticket + i * 0.09, K.ticket + 0.45 + i * 0.09));
              const moved = plan.moves.reduce((last, move) => (move.at <= t ? move.at : last), -1);
              const bump = moved < 0 ? 0 : Math.sin(Math.PI * span(t, moved, moved + 0.4));
              return (
                <div className={`film-card${bump > 0.02 ? " is-lifted" : ""}`} key={plan.key} style={{
                  left: at.x + (CELL.w * WIN.k) / 2 - 318, top: at.y + (CELL.h * WIN.k) / 2 - 96, zIndex: 5, opacity: clamp(e * 1.6) * (1 - 0.92 * closed),
                  transformOrigin: "100% 100%", transform: `translate3d(0, ${(1 - e) * -50}px, 0) scale(${(0.7 + 0.55 * e) * (1 + 0.06 * bump)})`
                }}>
                  <TicketCard plan={plan} words={PANES[lang][i]} variant={moved < 0 ? "doing" : plan.moves.filter((move) => move.at <= t).at(-1)!.to} t={t} lang={lang} clock={clock} age={0} />
                </div>
              );
            })}
          </div>
        )}
        <Caption t={t} at={K.snap + 0.35} until={K.need - 0.1} text={words.grid} lang={lang} x={WIDE.caption.x} y={WIDE.caption.y} size={WIDE.caption.size} width={WIDE.caption.width} flat />
        <Caption t={t} at={K.need} until={K.ticket - 0.1} text={words.status} lang={lang} x={WIDE.caption.x} y={WIDE.caption.y} size={WIDE.caption.size} width={WIDE.caption.width} flat />
        <Caption t={t} at={K.ticket} until={K.quit - 0.1} text={words.ticket} lang={lang} x={WIDE.caption.x} y={WIDE.caption.y} size={WIDE.caption.size} width={WIDE.caption.width} flat />
        <Caption t={t} at={K.quit} until={K.end} text={words.quit} lang={lang} x={WIDE.caption.x} y={WIDE.caption.y} size={WIDE.caption.size} width={WIDE.caption.width} flat />
        <End d={t - K.end} f={WIDE} lang={lang} />
      </>
    );
  },
  pointer: TERMINAL_POINTER,
  cues: terminalCues
});
