import { movedAt, statusAt, variantAt, type Status } from "../sim";
import type { Format } from "../stage";
import { clamp, ease, span } from "../time";
import { TicketCard } from "../Window";
import type { Lang } from "../words";
import { AGE, D, DEPS, LAY, NODE, PLAN, RUN, clock } from "./story";
import { TICKETS } from "./words";

/** The graph's own measures (workspace/GraphView.tsx): a card's width, and the room a row of them takes. */
const NODE_W = 260;
const ROW_H = 104;
const ARROW = 10;
/** The blocker's status colours its arrow, and a settled one is dashed (workspace/graphLook.ts). */
const STROKE: Record<Status, string> = { todo: "var(--meta)", doing: "var(--accent-light)", verifying: "var(--accent-light)", done: "var(--border)" };

/** The Dependencies view: the same cards the board draws, each to the right of what it waits on. */
export function Graph({ t, f, lang }: { t: number; f: Format; lang: Lang }) {
  const { scale, level, pitch } = LAY[f.id].graph;
  const from = D.merge + 0.5;
  const width = 2 * level + NODE_W;
  const height = 3 * pitch + ROW_H;
  const spot = (n: number) => ({ x: NODE[n][0] * level, y: ROW_H / 2 + NODE[n][1] * pitch });
  const enter = (n: number) => ease.back(span(t, from + NODE[n][0] * 0.16 + NODE[n][1] * 0.04, from + 0.5 + NODE[n][0] * 0.16 + NODE[n][1] * 0.04));
  return (
    <div className="graph-region film-graph">
      <div className="film-graph-canvas" style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}>
        <svg width={width} height={height} aria-hidden="true">
          {DEPS.map(([a, b]) => {
            const p = { x: spot(a).x + NODE_W + 5, y: spot(a).y };
            const q = { x: spot(b).x - 5, y: spot(b).y };
            const mid = (p.x + q.x) / 2;
            const status = statusAt(PLAN[a], t);
            const stroke = STROKE[status];
            // An open dependency carries a dot from the blocker to what it blocks, at one speed.
            const u = ((t * 110) / Math.hypot(q.x - p.x, q.y - p.y)) % 1;
            const dot = { x: (1 - u) ** 3 * p.x + 3 * (1 - u) ** 2 * u * mid + 3 * (1 - u) * u ** 2 * mid + u ** 3 * q.x, y: (1 - u) ** 3 * p.y + 3 * (1 - u) ** 2 * u * p.y + 3 * (1 - u) * u ** 2 * q.y + u ** 3 * q.y };
            return (
              <g key={`${a}-${b}`} style={{ opacity: clamp(span(t, from + 0.5 + NODE[b][0] * 0.16, from + 0.9 + NODE[b][0] * 0.16)) }}>
                <path d={`M${p.x},${p.y} C${mid},${p.y} ${mid},${q.y} ${q.x},${q.y}`} fill="none" style={{ stroke, strokeWidth: 1.5, strokeDasharray: status === "done" ? "4 3" : undefined }} />
                <path d={`M${q.x - ARROW},${q.y - 4.5} L${q.x},${q.y} L${q.x - ARROW},${q.y + 4.5} Z`} style={{ fill: stroke }} />
                {status !== "done" && <circle r={3} cx={dot.x} cy={dot.y} style={{ fill: stroke }} />}
              </g>
            );
          })}
        </svg>
        {RUN.map((n) => {
          const plan = PLAN[n];
          const { x, y } = spot(n);
          const e = enter(n);
          // A ticket the night has just moved on is lit for a moment.
          const moved = movedAt(plan, t);
          const lit = moved >= D.run ? 1 - span(t, moved, moved + 0.8) : 0;
          const bump = moved >= D.run ? Math.sin(Math.PI * span(t, moved, moved + 0.4)) : 0;
          return (
            <div className={`gnode film-node${lit > 0 ? " is-lit" : ""}`} key={plan.key} style={{ left: x, top: y, width: NODE_W, opacity: clamp(e * 1.5), transform: `translate3d(0, ${-50 + (1 - e) * 14}%, 0) scale(${0.94 + 0.06 * e + 0.05 * bump})`, ["--lit" as string]: lit }}>
              <TicketCard plan={plan} words={TICKETS[lang][n]} variant={variantAt(plan, t)} t={t} lang={lang} clock={clock} age={AGE[n]} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
