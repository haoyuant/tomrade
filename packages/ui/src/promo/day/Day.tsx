import type { CSSProperties } from "react";
import { say } from "~/lib/dicts";
import { VARIANTS, columnsAt, liveAt, place, statusAt, variantAt } from "../sim";
import { COL_W, HEAD_H, RAIL, TITLEBAR_H, TRACK_PAD, WIN_W, type Format } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { AppWindow, Ask, ColumnHeads, TicketCard, WallClock, type Board } from "../Window";
import type { Lang } from "../words";
import { Chat } from "./Chat";
import { Graph } from "./Graph";
import { AGE, D, LAY, PLAN, REDO, RUN, camera, clock, folded, scrolled } from "./story";
import { Terminal } from "./Terminal";
import { QUESTION, TICKETS } from "./words";

/** The idea's ticket leaves the assistant's reply and lands in To Do. */
const FLY = [D.ticket - 0.35, D.ticket + 0.45] as const;
/** The five tickets of the split come out of the first slot one after the other. */
const lag = (n: number): number => (n >= 1 && n <= 5 ? (n - 1) * 0.07 : 0);

/** How far a ticket is on the board: 0 away, 1 there. Only the split itself comes out staggered; a redo brings each back at its own click. */
function presence(n: number, t: number): number {
  const lives = PLAN[n].lives;
  if (!lives) return 1;
  return Math.max(...lives.map(([from, until], life) => {
    const start = from + (life === 0 ? lag(n) : 0);
    return ease.out(span(t, start, start + (life === 0 ? 0.5 : 0.3))) * (Number.isFinite(until) ? 1 - ease.in(span(t, until + lag(n) / 2, until + lag(n) / 2 + 0.32)) : 1);
  }));
}

/** What the status bar's ribbon names: the last write, and whose it was. */
function lastWrite(t: number, lang: Lang) {
  const assistant = say(lang, "agentPanel.assistantLabel");
  const writes = [
    { at: D.ticket, author: assistant, verb: "Created" as const, key: PLAN[0].key },
    { at: D.split, author: assistant, verb: "Created" as const, key: PLAN[5].key },
    { at: D.revert, author: assistant, verb: "Created" as const, key: PLAN[0].key },
    ...REDO.slice(0, 5).map((at, n) => ({ at, author: assistant, verb: "Created" as const, key: PLAN[n + 1].key })),
    ...PLAN.flatMap((plan) => plan.moves.map((move) => ({ at: move.at, author: plan.agent as string, verb: "Updated" as const, key: plan.key })))
  ];
  return writes.filter((write) => write.at <= t).sort((a, b) => b.at - a.at)[0] ?? null;
}

/**
 * The day's picture at t: the app's window, with the assistant, the board or the dependency graph in it as the story
 * has them, the terminal in front and the clock over the night. `leave` is how far the window has gone.
 */
export function Day({ t, f, lang, board: { measures, at }, leave }: { t: number; f: Format; lang: Lang; board: Board; leave: number }) {
  if (leave >= 1) return null;
  const lay = LAY[f.id];
  const cam = camera(t, f);
  const scroll = scrolled(t, f);
  const fold = folded(t);
  const graph = t >= D.merge + 0.35;
  const columns = columnsAt(PLAN, t);
  const waiting = PLAN.filter((plan) => variantAt(plan, t) === "waiting").length;
  const top = TITLEBAR_H + HEAD_H + TRACK_PAD + measures.head;
  const heightOf = (n: number) => measures.heights[n][VARIANTS.indexOf(variantAt(PLAN[n], t))];
  const card = (n: number) => <TicketCard plan={PLAN[n]} words={TICKETS[lang][n]} variant={variantAt(PLAN[n], t)} t={t} lang={lang} clock={clock} age={AGE[n]} />;

  const window: CSSProperties = {
    left: f.w / 2 - cam.wx * cam.s, top: f.winTop - cam.wy * cam.s + leave * 160, width: lay.w, height: cam.h, opacity: 1 - leave,
    transform: `scale(${cam.s * (1 - 0.04 * leave)})`
  };
  // Close on the composer the window reaches up behind the captions: it fades out under their band.
  const band: CSSProperties | undefined = cam.wy > 0 ? { maskImage: `linear-gradient(to bottom, transparent ${f.winTop - 70}px, black ${f.winTop - 12}px)` } : undefined;

  const fly = ease.inOut(span(t, FLY[0], FLY[1]));
  const landing = place(at[0], Math.max(t, D.ticket));
  const asked = place(at[3], t);
  const over = (
    <>
      {t >= FLY[0] && t < FLY[1] && (
        <div className="film-card is-lifted" style={{
          left: lerp(lay.w - lay.panel + 60, RAIL + TRACK_PAD + landing.x, fly), top: lerp(250, top + landing.y, fly) - Math.sin(Math.PI * fly) * 70,
          opacity: clamp(fly * 5), transform: `scale(${0.5 + 0.5 * fly})`, transformOrigin: "0 0", zIndex: 6
        }}>{card(0)}</div>
      )}
      {t >= D.ask + 0.2 && t <= D.answered + 0.4 && (
        <Ask lang={lang} question={QUESTION[lang]} show={ease.back(span(t, D.ask + 0.2, D.ask + 0.6)) * (1 - ease.in(span(t, D.answered + 0.08, D.answered + 0.3)))} picked={t >= D.picked}
          x={RAIL + TRACK_PAD + asked.x - scroll + COL_W + 14} y={top + asked.y + heightOf(3) / 2 - 46} />
      )}
    </>
  );

  return (
    <>
      <div className="film-band film-day" style={band}>
        <AppWindow
          lang={lang} style={window} layout={graph ? "graph" : "board"} waiting={waiting} over={over}
          shown={graph ? RUN.length : PLAN.filter((plan) => liveAt(plan, t)).length}
          going={t >= D.run ? { done: RUN.filter((n) => statusAt(PLAN[n], t) === "done").length, total: RUN.length } : null}
          ribbon={lastWrite(t, lang)}
          assistant={fold < 1 ? <div className="film-fold" style={{ width: lerp(lay.panel, RAIL, fold), opacity: 1 - fold }}><Chat t={t} lang={lang} width={lay.panel} /></div> : undefined}
        >
          {graph ? <Graph t={t} f={f} lang={lang} /> : (
            <div className="board-scroll-area film-clip" style={{ opacity: 1 - span(t, D.merge + 0.1, D.merge + 0.35) }}>
              <div className="col-track film-track" style={{ width: WIN_W - 2 * RAIL, flex: "1 0 auto", transform: `translate3d(${-scroll}px, 0, 0)` }}>
                <ColumnHeads columns={columns} lang={lang} />
                {PLAN.map((plan, n) => {
                  // The idea's ticket is drawn over the window until it has landed. Once the run is taken back it lies over
                  // the tickets a redo deals out from under it.
                  const here = n === 0 && t < D.split ? (t >= FLY[1] ? 1 : 0) : presence(n, t);
                  if (here <= 0.001) return null;
                  const spot = place(at[n], t);
                  return (
                    <div className={`film-card${spot.lift > 0.02 ? " is-lifted" : ""}`} key={plan.key} style={{
                      left: TRACK_PAD + lerp(0, spot.x, here), top: TRACK_PAD + measures.head + lerp(0, spot.y, here), opacity: clamp(here * 1.6),
                      transform: `translate3d(0, ${-12 * spot.lift}px, 0) scale(${(0.9 + 0.1 * here) * (1 + 0.045 * spot.lift)})`, zIndex: spot.lift > 0.02 || (n === 0 && t >= D.revert) ? 3 : here < 1 ? 2 : 1
                    }}>{card(n)}</div>
                  );
                })}
              </div>
            </div>
          )}
        </AppWindow>
      </div>
      <Terminal t={t} f={f} lang={lang} />
      {t >= D.run + 0.4 && <WallClock minutes={clock(t)} show={Math.min(ease.outQuint(span(t, D.run + 0.4, D.run + 0.9)), 1 - leave)} f={f} />}
    </>
  );
}
