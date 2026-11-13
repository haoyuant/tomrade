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

/** The canvas the camera flies over, and where on it each of the six scenes stands. */
const MAP = { w: 5600, h: 3400 };
const STOPS: [number, number][] = [[900, 800], [2800, 1040], [4700, 800], [4700, 2520], [2800, 2280], [900, 2520]];
const K = 1.36;
const WHOLE = { x: MAP.w / 2, y: MAP.h / 2, s: 0.3 };

/** One take: all six scenes laid out on one sheet, and a camera that goes from one to the next on the bar. */
export function flyover(id: string, bars: Bars): FilmDef {
  const song = songOf("flyover", bars);
  const beat = 60 / song.bpm;
  return film<true>({
    id,
    shelf: "1-launch/flyover",
    seconds: secondsOf(song),
    poster: (bars.features + 1.5 * bars.each) * beat,
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
      const leave = ease.in(span(q, bars.end - 0.5, bars.end + 0.4));
      // Where the camera is: over the whole sheet, then at each stop, travelling in the first beats of its bars.
      const at = (i: number) => (i < 0 || i > 5 ? WHOLE : { x: STOPS[i][0], y: STOPS[i][1] - 100, s: 1 });
      const index = on ? on.index : q < bars.features ? -1 : 6;
      const local = on ? (q - bars.features) % bars.each : q >= bars.recap ? q - bars.recap : 0;
      const go = ease.inOut(clamp(local / 1.8));
      const from = at(index - 1);
      const to = at(index);
      const cam = { x: lerp(from.x, to.x, go), y: lerp(from.y, to.y, go), s: lerp(from.s, to.s, go) * (index >= 0 && index < 6 ? 1 - 0.34 * Math.sin(Math.PI * go) : 1) };
      const drawn = clamp((q - bars.features) / (bars.recap - bars.features));
      const route = STOPS.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
      return (
        <div className="fly" lang={lang}>
          {leave < 1 && (
            <div className="fly-sheet" style={{ width: MAP.w, height: MAP.h, opacity: 1 - leave, transform: `translate3d(${WIDE.w / 2 - cam.x}px, ${WIDE.h / 2 - cam.y}px, 0) scale(${cam.s}) rotate(${(index % 2 ? 1 : -1) * 2.4 * Math.sin(Math.PI * go) * (index >= 0 && index < 6 ? 1 : 0)}deg)`, transformOrigin: `${cam.x}px ${cam.y}px` }}>
              <svg width={MAP.w} height={MAP.h} aria-hidden="true"><path d={route} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - (q >= bars.recap ? 1 : drawn) }} /></svg>
              {words.features.map((one, n) => (
                <div className="fly-stop" key={one.key} style={{ left: STOPS[n][0], top: STOPS[n][1], opacity: index === n || q >= bars.recap ? 1 : 0.3 }}>
                  <div className="fly-words"><b>{one.verb}</b><div><strong>{one.title}</strong><em>{one.line}</em></div><span className="num">0{n + 1} / 06</span></div>
                  <div className="fly-frame" style={{ transform: `scale(${K * (index === n ? 1 + 0.006 * pulse(q) : 1)})` }}><Vignette id={one.key} u={index === n && on ? on.u : index > n ? 7.6 : 0} lang={lang} /></div>
                </div>
              ))}
            </div>
          )}
          {q < bars.features && <i className="fly-veil" style={{ opacity: 1 - span(q, bars.features - 1, bars.features) }} />}
          <Caption t={t} at={-1.5} until={bars.define * beat} text={words.hook[0]} lang={lang} x={0} y={330} size={128} width={WIDE.w} align="center" />
          <Caption t={t} at={(bars.define / 2) * beat} until={bars.define * beat} text={words.hook[1]} lang={lang} x={0} y={500} size={128} width={WIDE.w} align="center" />
          <Caption t={t} at={bars.define * beat} until={(bars.features - 0.3) * beat} text={`*${words.name}*`} lang={lang} x={0} y={250} size={170} width={WIDE.w} align="center" />
          <Caption t={t} at={(bars.define + 1.5) * beat} until={(bars.features - 0.3) * beat} text={words.define} lang={lang} x={0} y={470} size={84} width={WIDE.w} align="center" />
          <Caption t={t} at={(bars.define + 3.5) * beat} until={(bars.features - 0.3) * beat} text={words.defineMore} lang={lang} x={160} y={620} size={44} width={WIDE.w - 320} align="center" />
          <End d={(q - bars.end - 0.3) * beat} f={WIDE} lang={lang} />
          {q >= bars.end + 4 && <p className="beat-facts" style={{ opacity: clamp(q - bars.end - 4) }}>{words.facts.join(" · ")}</p>}
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => launchCues(song, bars)
  });
}
