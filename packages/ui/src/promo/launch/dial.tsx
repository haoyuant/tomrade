import { pulse } from "../beat/kit";
import { film, type FilmDef } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { featureAt, launchCues, secondsOf, songOf, type Bars } from "./scripts";
import { Vignette } from "./vignettes";
import { LAUNCH } from "./words";

/** The hour each feature happens at, on a day that starts at nine and ends the next morning. */
const HOURS = [9, 10.5, 14, 16, 18.5, 23];
const END_HOUR = 31;
const RING = { x: 400, y: 600, r: 290 };
const two = (n: number): string => String(n).padStart(2, "0");
const around = (hour: number, r: number): { x: number; y: number } => ({ x: RING.x + r * Math.sin((hour / 24) * 2 * Math.PI), y: RING.y - r * Math.cos((hour / 24) * 2 * Math.PI) });

/** The dial: one day round a 24-hour face; the hand comes to an hour, and what happens then plays beside it. */
export function dial(id: string, bars: Bars): FilmDef {
  const song = songOf("clock", bars);
  const beat = 60 / song.bpm;
  return film<true>({
    id,
    shelf: "1-launch/dial",
    seconds: secondsOf(song),
    poster: (bars.features + 5.6 * bars.each) * beat,
    formats: ["wide"],
    bare: true,
    song,
    day: () => 0,
    rise: () => 0,
    skyTime: (t) => t,
    Prepare: Ready,
    Picture: ({ t, lang }) => {
      const q = t / beat;
      const words = LAUNCH[lang];
      const on = featureAt(bars, q);
      const local = on ? (q - bars.features) % bars.each : 0;
      const leave = ease.in(span(q, bars.end - 0.5, bars.end + 0.4));
      // The hand moves to a feature's hour as its bars begin; through the last feature it goes on round to morning.
      const hour = !on
        ? q < bars.features ? HOURS[0] : END_HOUR
        : lerp(on.index ? HOURS[on.index - 1] : HOURS[0], HOURS[on.index], ease.inOut(clamp(local / 1.6))) + (on.index === 5 ? (END_HOUR - HOURS[5]) * ease.inOut(span(on.u, 1.5, 7.2)) : 0);
      const tip = around(hour, RING.r - 36);
      const night = hour % 24 >= 19 || hour % 24 < 6;
      const drawn = ease.out(span(q, 0, bars.define * 0.8));
      const arc = (from: number, to: number) => {
        const a = around(from, RING.r);
        const b = around(to, RING.r);
        return `M${a.x},${a.y} A${RING.r},${RING.r} 0 ${to - from > 12 ? 1 : 0} 1 ${b.x},${b.y}`;
      };
      return (
        <div className="dial" lang={lang}>
          {leave < 1 && (
            <div className="dial-stage" style={{ opacity: 1 - leave }}>
              <svg width={WIDE.w} height={WIDE.h} aria-hidden="true">
                <circle className="dial-face" cx={RING.x} cy={RING.y} r={RING.r} pathLength={1} style={{ strokeDashoffset: 1 - drawn }} />
                <path className="dial-night" d={arc(19, 30)} style={{ opacity: drawn }} />
                {q >= bars.features && <path className="dial-done" d={arc(HOURS[0], Math.min(hour, HOURS[0] + 23.9))} />}
                {Array.from({ length: 24 }, (_, h) => { const a = around(h, RING.r - 16); const b = around(h, RING.r - (h % 6 ? 26 : 40)); return <path key={h} className="dial-tick" d={`M${a.x},${a.y} L${b.x},${b.y}`} style={{ opacity: drawn }} />; })}
                {HOURS.map((h, n) => { const at = around(h, RING.r); const lit = on ? n <= on.index : q >= bars.recap; return <circle key={n} className={`dial-mark${lit ? " is-lit" : ""}`} cx={at.x} cy={at.y} r={lit ? 15 + 8 * (on && n === on.index ? pulse(q, 4) : 0) : 9} />; })}
                {q >= bars.features - 1 && <path className="dial-hand" d={`M${RING.x},${RING.y} L${tip.x},${tip.y}`} />}
                {q >= bars.features - 1 && <circle className={`dial-tip${night ? " is-night" : ""}`} cx={tip.x} cy={tip.y} r={20} />}
              </svg>
              {[0, 6, 12, 18].map((h) => <span className="dial-hour num" key={h} style={{ left: around(h, RING.r + 44).x, top: around(h, RING.r + 44).y, opacity: drawn }}>{two(h)}</span>)}
              {q >= bars.recap && words.features.map((one, n) => <b className="dial-verb" key={one.key} style={{ left: around(HOURS[n], RING.r + (n === 5 ? 62 : 58)).x, top: around(HOURS[n], RING.r + 58).y, transform: `translate(-50%, -50%) scale(${ease.back(span(q, bars.recap + n * 0.3, bars.recap + 0.7 + n * 0.3))})` }}>{one.verb}</b>)}
              <div className="dial-now">
                {q >= bars.features ? <><span className="num">{two(Math.floor(hour) % 24)}:{two(Math.floor((hour % 1) * 6) * 10)}</span>{on && <b key={on.index}>{words.features[on.index].verb}</b>}</> : <i className="film-sun dial-sun" style={{ transform: `scale(${ease.back(span(q, bars.define, bars.define + 0.8))})` }}><i className="film-sun-cat" /></i>}
              </div>
              {on && (
                <div className="dial-feature" key={on.index}>
                  <div className="dial-words" style={{ opacity: clamp(local * 5), transform: `translate3d(${(1 - ease.outQuint(clamp(local / 1.2))) * 50}px, 0, 0)` }}>
                    <strong>{words.features[on.index].title}</strong>
                    <em>{words.features[on.index].line}</em>
                  </div>
                  <div className="dial-card" style={{ opacity: clamp(local * 4), transform: `translate3d(${(1 - ease.outQuint(clamp(local / 1.4))) * 120}px, 0, 0) scale(${1.16 * (1 + 0.005 * pulse(q))})` }}>
                    <Vignette id={words.features[on.index].key} u={on.u} lang={lang} />
                  </div>
                </div>
              )}
              {q >= bars.recap && (
                <ul className="dial-list">
                  {words.features.map((one, n) => <li key={one.key} style={{ opacity: clamp((q - bars.recap - n * 0.3) * 4) }}><span className="num">{two(Math.floor(HOURS[n]))}:{two((HOURS[n] % 1) * 60)}</span><b>{one.verb}</b>{one.title}</li>)}
                </ul>
              )}
            </div>
          )}
          <Caption t={t} at={-1.5} until={bars.define * beat} text={words.hook[0]} lang={lang} x={800} y={380} size={104} width={1060} />
          <Caption t={t} at={(bars.define / 2) * beat} until={bars.define * beat} text={words.hook[1]} lang={lang} x={800} y={520} size={104} width={1060} />
          <Caption t={t} at={bars.define * beat} until={(bars.features - 0.3) * beat} text={`*${words.name}*`} lang={lang} x={800} y={300} size={150} width={1060} />
          <Caption t={t} at={(bars.define + 1.5) * beat} until={(bars.features - 0.3) * beat} text={words.define} lang={lang} x={800} y={490} size={72} width={1060} />
          <Caption t={t} at={(bars.define + 3.5) * beat} until={(bars.features - 0.3) * beat} text={words.defineMore} lang={lang} x={800} y={620} size={40} width={1040} />
          <End d={(q - bars.end - 0.3) * beat} f={WIDE} lang={lang} />
          {q >= bars.end + 4 && <p className="beat-facts" style={{ opacity: clamp(q - bars.end - 4) }}>{words.facts.join(" · ")}</p>}
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => launchCues(song, bars)
  });
}
