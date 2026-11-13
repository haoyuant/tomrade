import { film } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { Lines, hit } from "./kit";
import { CHANGES, METRO, METRO_BEAT, METRO_SECONDS, TRAINS, arrived, metroCues, trainAt } from "./scripts";
import { METRO_WORDS } from "./words";

const OUT = METRO.marks.out;
/** The map: each line's height and colour, where the stations stand, the terminus all lines run into, and the person's own station up a spur. */
const LINES = [{ y: 470, colour: "#e8552d", name: "Claude Code" }, { y: 610, colour: "#159a92", name: "Codex" }, { y: 750, colour: "#6a57d5", name: "Cursor" }];
const STOP = (index: number): number => 330 + index * 250;
const END = { x: 1800, y: 610 };
const YOU = { x: STOP(3), y: 300 };
const track = (y: number): string => `M${STOP(0)},${y} H${STOP(5)} C${STOP(5) + 110},${y} ${END.x - 110},${END.y} ${END.x},${END.y}`;
/** Where a train is on the frame: along its line, up the spur, or on the curve into the terminus. */
function place(line: number, at: number, up: number): { x: number; y: number } {
  const y = LINES[line].y;
  if (at <= 5) return { x: STOP(0) + at * 250, y: lerp(y, YOU.y, up) };
  const u = at - 5;
  const bend = (a: number, b: number, c: number, d: number) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u ** 2 * c + u ** 3 * d;
  return { x: bend(STOP(5), STOP(5) + 110, END.x - 110, END.x), y: bend(y, y, END.y, END.y) };
}

/** "Every agent, a line of its own.": a transit map; tickets are trains, and one station is the person's. */
export const metro = film<true>({
  id: "metro",
  shelf: "2-stories/metro",
  seconds: METRO_SECONDS,
  poster: 18 * METRO_BEAT,
  formats: ["wide"],
  bare: true,
  song: METRO,
  // the map is paper by day and ink through the night service
  day: (t) => 1 - ease.inOut(span(t / METRO_BEAT, CHANGES.night - 0.5, CHANGES.night + 1)) + ease.inOut(span(t / METRO_BEAT, CHANGES.day - 0.5, CHANGES.day + 1)),
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / METRO_BEAT;
    const words = METRO_WORDS[lang];
    const leave = ease.in(span(q, OUT - 0.4, OUT + 0.6));
    const night = q >= CHANGES.night && q < CHANGES.day;
    return (
      <div className="metro" lang={lang}>
        {leave < 1 && (
          <div className="metro-map" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 120}px, 0)` }}>
            <svg width={WIDE.w} height={WIDE.h} aria-hidden="true">
              {LINES.map((line, n) => <path key={n} className="metro-track" d={track(line.y)} pathLength={1} style={{ stroke: line.colour, strokeDasharray: 1, strokeDashoffset: 1 - ease.out(span(q, n * 0.9, n * 0.9 + 2.2)) }} />)}
              <path className="metro-spur" d={`M${YOU.x},${LINES[0].y} V${YOU.y}`} style={{ opacity: span(q, 5, 6.5) }} />
              {LINES.flatMap((line, n) => [0, 1, 2, 3, 4, 5].map((index) => <circle key={`${n}-${index}`} className="metro-stop" cx={STOP(index)} cy={line.y} r={20 * ease.back(span(q, 3 + index * 0.5 + n * 0.12, 3.6 + index * 0.5 + n * 0.12))} />))}
              <circle className="metro-stop is-big" cx={END.x} cy={END.y} r={34 * ease.back(span(q, 6, 6.8))} />
              <circle className={`metro-stop is-you${q >= CHANGES.asks && q < CHANGES.answered ? " is-asked" : ""}`} cx={YOU.x} cy={YOU.y} r={(30 + 6 * Math.sin(q * Math.PI * 2) * (q >= CHANGES.asks && q < CHANGES.answered ? 1 : 0)) * ease.back(span(q, 5.6, 6.6))} />
            </svg>
            {words.stops.map((name, index) => <b className="metro-name" key={name} style={{ left: index === 6 ? END.x : STOP(index), top: index === 6 ? END.y + 54 : LINES[2].y + 44, opacity: span(q, 3.2 + index * 0.5, 4 + index * 0.5) }}>{name}</b>)}
            <b className="metro-name is-you" style={{ left: YOU.x, top: YOU.y - 92, opacity: span(q, 5.8, 6.8) }}>{words.you}</b>
            {LINES.map((line, n) => <span className="metro-line" key={line.name} style={{ top: line.y, background: line.colour, opacity: span(q, n * 0.9, n * 0.9 + 1) }}>{line.name}</span>)}
            {TRAINS.map(({ line, leaves }, j) => {
              if (q < leaves - 0.4) return null;
              const where = trainAt(j, q);
              const spot = place(line, where.at, where.up);
              // a train gives a little as it pulls in to a station
              const stopped = hit(q, leaves + Math.floor(q - leaves), 5);
              return <i className="metro-train" key={j} style={{ left: spot.x, top: spot.y, background: LINES[line].colour, opacity: clamp((q - leaves + 0.4) * 3), transform: `translate(-50%, -50%) scale(${1 + 0.16 * stopped})` }}>{53 + j}</i>;
            })}
            <div className="metro-key" style={{ opacity: span(q, 6, 7.5) }}>
              <b>{words.title}</b><span>{LINES.map((line) => line.name).join(" · ")} · {words.any}</span>
              {night && <em>{words.night}</em>}
            </div>
            <div className="metro-count num" style={{ opacity: span(q, 13, 14), transform: `scale(${1 + 0.2 * Math.max(...TRAINS.map((_, j) => hit(q, TRAINS[j].leaves + (j === CHANGES.train ? 10 : 6), 3)))})` }}>{words.merged} {arrived(q)}/8</div>
          </div>
        )}
        <Lines t={t} beat={METRO_BEAT} lines={words.lines} lang={lang} y={56} size={72} />
        <End d={(q - OUT - 0.5) * METRO_BEAT} f={WIDE} lang={lang} />
        {q >= OUT + 5 && <p className="beat-facts" style={{ opacity: clamp(q - OUT - 5) }}>{words.facts}</p>}
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: metroCues
});
