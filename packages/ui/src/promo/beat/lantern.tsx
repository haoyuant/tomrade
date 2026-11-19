import { film } from "../Film";
import { Ready } from "../free/Ready";
import { clamp, ease, lerp, noise, span } from "../time";
import { OUTRO } from "../words";
import { LANTERN, LANTERN_BEAT, LANTERN_SECONDS, RIVER, lanternCues } from "./scripts";
import { RIVER_LINES } from "./words";

const W = 1920;
const H = 1080;
/** The river's line, the bank the lanterns are set down from, the bridge that lets through what passed its checks, and where the sun comes up. */
const WATER = 742;
const BANK = 330;
const BRIDGE = 1180;
const SUN = { x: 1560, y: 400, r: 120 };
const two = (n: number): string => String(n).padStart(2, "0");

/** Where a lantern is at beat q, and how it stands: `flame` once its agent has it, `lit` once it is merged, `waits` while it is held for the person. */
function lantern(i: number, q: number) {
  const last = i === RIVER.waits;
  const set = RIVER.first + i;
  const through = last ? RIVER.last : RIVER.bridge + i;
  // each drifts at one pace, so that one a beat reaches the bridge; the last is held just short of it
  const drift = BANK + ((BRIDGE - BANK) * (Math.min(q, through) - set)) / (RIVER.bridge - RIVER.first);
  const held = BRIDGE - 104;
  const waits = last && q >= RIVER.bridge + i - 1.5 && q < RIVER.answer;
  let x = last ? (q < RIVER.answer ? Math.min(drift, held) : lerp(held, BRIDGE, ease.inOut(span(q, RIVER.answer, RIVER.last)))) : drift;
  // past the bridge it joins the others downstream, then goes up to the sun
  const rest = 1322 + (last ? 7 : i) * 66;
  const after = ease.out(span(q, through, through + 3));
  x = lerp(x, rest, q >= through ? after : 0);
  const up = ease.inOut(span(q, (last ? RIVER.name - 0.4 : RIVER.dawn + 1.5 + i * 0.35), (last ? RIVER.name + 1.2 : RIVER.dawn + 4 + i * 0.35)));
  return {
    x: lerp(x, SUN.x, up), y: lerp(WATER + Math.sin(q * 1.3 + i) * 6, SUN.y, up), shown: clamp((q - set) * 2) * (1 - span(up, 0.7, 1)),
    flame: q >= RIVER.flame + i * 0.5, lit: q >= through, waits, small: 1 - 0.5 * up
  };
}

/** "Eleven at night.": a night told slowly, in thin lines; each ticket is a lantern on a river. */
export const lanterns = film<true>({
  id: "lantern",
  shelf: "2-stories/lantern",
  seconds: LANTERN_SECONDS,
  poster: 23 * LANTERN_BEAT,
  formats: ["wide"],
  bare: true,
  song: LANTERN,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / LANTERN_BEAT;
    const day = ease.inOut(span(q, RIVER.dawn - 0.6, RIVER.dawn + 2.2));
    const moon = span(q, 0, RIVER.dawn + 2);
    const minutes = 23 * 60 + moon * 8 * 60;
    const sun = ease.out(span(q, RIVER.dawn - 0.5, RIVER.dawn + 4));
    const named = ease.out(span(q, RIVER.name, RIVER.name + 2));
    const wave = (phase: number, y: number) => `M0,${y} ${Array.from({ length: 13 }, (_, k) => `Q${k * 160 + 80},${y + (k % 2 ? 9 : -9) * Math.sin(q * 0.5 + phase)} ${(k + 1) * 160},${y}`).join(" ")}`;
    const outro = OUTRO[lang];
    return (
      <div className="river" lang={lang} style={{ ["--day" as string]: day }}>
        <i className="river-dawn" />
        {Array.from({ length: 70 }, (_, i) => <i className="river-star" key={i} style={{ left: `${noise(i, 1) * 100}%`, top: `${noise(i, 2) * 58}%`, opacity: (0.35 + 0.65 * noise(i, 3)) * (0.7 + 0.3 * Math.sin(q * 2 + i)) * (1 - day) }} />)}
        <div className="river-moon" style={{ left: lerp(300, 1500, moon), top: 300 - Math.sin(Math.PI * moon) * 150 + moon * 120, opacity: 1 - day }}>
          <span className="num">{two(Math.floor(minutes / 60) % 24)}:{two(Math.floor(minutes % 60 / 10) * 10)}</span>
        </div>
        <div className="river-sun" style={{ left: SUN.x, top: lerp(WATER + 60, SUN.y, sun), width: 2 * SUN.r, height: 2 * SUN.r, opacity: clamp(sun * 3), transform: `translate(-50%, -50%) scale(${1 + 0.5 * named})` }}>
          <i className="film-sun-cat" style={{ opacity: named }} />
        </div>
        <svg className="river-lines" width={W} height={H} aria-hidden="true">
          {/* the house the person goes to bed in: its window dark once they have */}
          <path d="M70,700 V556 L196,462 L322,556 V700" />
          <rect x="156" y="590" width="80" height="72" style={{ fill: `color-mix(in srgb, var(--river-warm) ${Math.round(100 * (1 - span(q, 11.5, 12.5)))}%, transparent)` }} />
          <path d="M0,700 H400" />
          {/* the bridge: only what passed its checks goes under it */}
          <g style={{ opacity: span(q, 15, 18) }}>
            <path d={`M${BRIDGE - 140},${WATER - 50} Q${BRIDGE},${WATER - 260} ${BRIDGE + 140},${WATER - 50}`} />
            <path d={`M${BRIDGE - 140},${WATER - 50} V${WATER + 24} M${BRIDGE + 140},${WATER - 50} V${WATER + 24}`} />
            <circle cx={BRIDGE} cy={WATER - 206} r="34" />
            <path d={`M${BRIDGE - 15},${WATER - 206} l11,12 l20,-24`} />
          </g>
          <path className="is-water" d={wave(0, WATER + 34)} />
          <path className="is-water" d={wave(2, WATER + 78)} />
          <path className="is-water" d={wave(4, WATER + 126)} />
        </svg>
        {Array.from({ length: 8 }, (_, i) => {
          const at = lantern(i, q);
          if (at.shown <= 0) return null;
          return (
            <div className={`river-lantern${at.lit ? " is-lit" : at.waits ? " is-waiting" : ""}`} key={i} style={{ left: at.x, top: at.y, opacity: at.shown, transform: `translate(-50%, -100%) scale(${at.small * (at.waits ? 1 + 0.06 * Math.sin(q * Math.PI * 2) : 1)})` }}>
              {(at.flame || at.lit) && <i style={{ opacity: 0.75 + 0.25 * Math.sin(q * 9 + i * 2) }} />}
            </div>
          );
        })}
        {RIVER_LINES[lang].map(([line, from, until]) => (q >= from - 0.2 && q < until + 0.5 ? <p className="river-line" key={line} style={{ opacity: Math.min(span(q, from - 0.2, from + 0.4), 1 - span(q, until, until + 0.5)) }}>{line}</p> : null))}
        <div className="river-name" style={{ opacity: named, transform: `translate3d(0, ${(1 - named) * 20}px, 0)` }}>
          <b>Tomrade</b>
          <span>{outro.tagline.replace("\n", lang === "zh" ? "" : " ")}</span>
          <em>{outro.get}</em>
        </div>
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: lanternCues
});
