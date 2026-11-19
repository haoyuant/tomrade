import type { CSSProperties } from "react";
import { VARIANTS, columnsAt, place, statusAt, variantAt } from "../sim";
import { COL_W, HEAD_H, TITLEBAR_H, TRACK_PAD, WIN_W, colLeft, type Format } from "../stage";
import { ease, lerp, span } from "../time";
import { AppWindow, Ask, ColumnHeads, Measure as Measures, TicketCard, WallClock, type Board, type Measures as Sizes, type Paths } from "../Window";
import type { Lang } from "../words";
import { ANSWERED, PLAN, RUN, RUN_FROM, hop } from "./plan";
import { LAYOUT, T, camera, clock, folded } from "./stage";
import { QUESTION, TICKETS } from "./words";

/** When the question comes up beside its ticket, and when the clock comes up over the night. */
const ASKED = 10.95;
const CLOCK_FROM = T.night + 0.55;

/** How long ago each ticket was last touched when the film opens, in minutes. */
const AGE = [130, 310, 1500, 190, 2900, 380, 1440, 4300, 5800, 22, 200];

export function Measure({ lang, onDone }: { lang: Lang; onDone: (board: Board) => void }) {
  return <Measures plans={PLAN} words={TICKETS[lang]} lang={lang} clock={clock} age={AGE} t={T.dawn} onDone={onDone} />;
}

/** The middle of a ticket's card in the window's pixels, at t. */
function cardCentre(n: number, t: number, at: Paths, measures: Sizes): { x: number; y: number } {
  const spot = place(at[n], t, hop);
  const height = measures.heights[n][VARIANTS.indexOf(variantAt(PLAN[n], t))];
  return { x: colLeft(0) + spot.x + COL_W / 2, y: TITLEBAR_H + HEAD_H + TRACK_PAD + measures.head + spot.y + height / 2 };
}

/**
 * One of the opening's terminals on its way into the board: where its middle is on the frame, its scale against a
 * terminal's own size, its tilt, and how far it has become a card.
 */
export function flight(n: number, t: number, f: Format, at: Paths, measures: Sizes) {
  const e = folded(n, t);
  const cam = camera(t, f);
  const pane = LAYOUT[f.id].pane;
  const [px, py, tilt] = pane.at[n];
  const slot = cardCentre(n, t, at, measures);
  return {
    e,
    x: lerp(px, cam.left + slot.x * cam.s, e),
    y: lerp(py, cam.top + slot.y * cam.s, e) - Math.sin(Math.PI * e) * 70,
    scale: lerp(1, (COL_W * cam.s) / pane.w, e),
    tilt: lerp(tilt, 0, e),
    card: span(e, 0.32, 0.7)
  };
}

/** The app's window with the board in it, as the story has it at t. */
export function BoardScene({ t, f, lang, at, measures }: { t: number; f: Format; lang: Lang; at: Paths; measures: Sizes }) {
  if (t < T.turn || t > T.proof + 0.6) return null;
  const cam = camera(t, f);
  const columns = columnsAt(PLAN, t);
  const delivered = RUN.filter((n) => statusAt(PLAN[n], t) === "done").length;
  const waiting = PLAN.filter((plan) => variantAt(plan, t) === "waiting").length;
  // The last write, as the status bar's ribbon names it.
  const last = PLAN.flatMap((plan) => plan.moves.map((move) => ({ plan, move }))).filter(({ move }) => move.at <= t).sort((a, b) => b.move.at - a.move.at)[0];
  const leave = ease.in(span(t, T.proof - 0.1, T.proof + 0.5));
  const show = ease.out(span(t, T.turn, T.turn + 0.55)) * (1 - leave);
  const asked = cardCentre(2, Math.max(t, ASKED), at, measures);
  const pane = LAYOUT[f.id].pane;
  const window: CSSProperties = {
    left: cam.left, top: cam.top + leave * 160, width: WIN_W, height: cam.winH, opacity: show,
    transform: `scale(${cam.s * (1 - 0.04 * leave)})`
  };
  return (
    <>
      <AppWindow
        lang={lang} style={window} shown={PLAN.length} waiting={waiting}
        going={t >= RUN_FROM ? { done: delivered, total: RUN.length } : null}
        ribbon={last ? { author: last.plan.agent, verb: "Updated", key: last.plan.key } : null}
        over={t >= ASKED && t <= RUN_FROM + 0.5 && (
          <Ask lang={lang} question={QUESTION[lang]} show={ease.back(span(t, ASKED, ASKED + 0.4)) * (1 - ease.in(span(t, ANSWERED + 0.08, ANSWERED + 0.3)))} picked={t >= 12.14} x={asked.x + COL_W / 2 + 14} y={asked.y - 46} />
        )}
      >
        <div className="board-scroll-area">
          <div className="col-track film-track">
            <ColumnHeads columns={columns} lang={lang} />
            {PLAN.map((plan, n) => {
              const spot = place(at[n], t, hop);
              const fly = n < pane.at.length && t < T.board + 0.6 ? flight(n, t, f, at, measures) : null;
              const slot = cardCentre(n, t, at, measures);
              // A card that began as a terminal comes in along the terminal's path, growing out of it.
              const entry = fly && fly.e < 1
                ? `translate3d(${(fly.x - cam.left) / cam.s - slot.x}px, ${(fly.y - cam.top) / cam.s - slot.y}px, 0) rotate(${fly.tilt}deg) scale(${(fly.scale * pane.w) / (COL_W * cam.s)})`
                : `translate3d(0, ${-12 * spot.lift}px, 0) scale(${1 + 0.045 * spot.lift})`;
              return (
                <div className={`film-card${spot.lift > 0.02 ? " is-lifted" : ""}`} key={plan.key} style={{ left: TRACK_PAD + spot.x, top: TRACK_PAD + measures.head + spot.y, opacity: fly ? fly.card : 1, transform: entry, zIndex: spot.lift > 0.02 || (fly && fly.e < 1) ? 3 : 1 }}>
                  <TicketCard plan={plan} words={TICKETS[lang][n]} variant={variantAt(plan, t)} t={t} lang={lang} clock={clock} age={AGE[n]} />
                </div>
              );
            })}
          </div>
        </div>
      </AppWindow>
      {t >= CLOCK_FROM && t < T.proof && <WallClock minutes={clock(t)} show={Math.min(ease.outQuint(span(t, CLOCK_FROM, CLOCK_FROM + 0.5)), 1 - ease.in(span(t, T.proof - 0.25, T.proof)))} f={f} />}
    </>
  );
}
