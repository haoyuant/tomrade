import { pulse } from "../beat/kit";
import { film, type FilmDef } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { LOOK } from "../look";
import { featureAt, launchCues, secondsOf, songOf, type Bars } from "./scripts";
import { VG, Vignette } from "./vignettes";
import { LAUNCH } from "./words";

/** How each photo lies on its page, and where the pen circles it: a tilt, and the circle's middle and size on the photo. */
const LAID: { tilt: number; ring: [number, number, number, number] }[] = [
  { tilt: -2.4, ring: [300, 78, 300, 70] }, { tilt: 1.8, ring: [650, 442, 420, 120] }, { tilt: -1.6, ring: [330, 303, 130, 40] },
  { tilt: 2.2, ring: [346, 438, 120, 50] }, { tilt: -2, ring: [232, 126, 330, 46] }, { tilt: 1.5, ring: [150, 492, 250, 50] }
];

/** The magazine: paper, a serif, one red; the app's pieces are photographs laid on the page, with the pen's notes on them. */
export function zine(id: string, bars: Bars): FilmDef {
  const song = songOf("zine", bars);
  const beat = 60 / song.bpm;
  return film<true>({
    id,
    shelf: "1-launch/zine",
    seconds: secondsOf(song),
    poster: (bars.features + 3.6 * bars.each) * beat,
    formats: ["wide"],
    bare: true,
    song,
    day: () => 1,
    rise: () => 0,
    skyTime: (t) => t,
    Prepare: Ready,
    Picture: ({ t, lang }) => {
      const q = t / beat;
      const words = LAUNCH[lang];
      const on = featureAt(bars, q);
      const local = on ? (q - bars.features) % bars.each : 0;
      const leave = ease.in(span(q, bars.end - 0.5, bars.end + 0.4));
      const strip = (text: string) => text.replace(/\*/g, "");
      return (
        <div className="zine" lang={lang}>
          {q < bars.define && (
            <div className="zine-cover">
              <b style={{ letterSpacing: `${0.2 + 0.1 * ease.outQuint(span(q, 0, 2))}em` }}>TOMRADE</b>
              <i />
              <strong>{strip(words.hook[0])}</strong>
              {q >= bars.define / 2 && <strong className="is-red" style={{ transform: `scale(${1 + 0.05 * Math.exp(-(q - bars.define / 2) * 3)})` }}>{strip(words.hook[1])}</strong>}
              <span>No. 01 · {words.features.map((one) => one.verb).join(" ")}</span>
            </div>
          )}
          {q >= bars.define && q < bars.features && (
            <div className="zine-define" style={{ opacity: clamp((q - bars.define) * 4) }}>
              <span>{words.name}</span>
              <blockquote>“{words.define}”</blockquote>
              <p style={{ opacity: clamp((q - bars.define - 2.5) * 3) }}>{words.defineMore}</p>
            </div>
          )}
          {on && (
            <div className="zine-spread" key={on.index}>
              <div className="zine-page" style={{ opacity: clamp(local * 5), transform: `translate3d(${(1 - ease.outQuint(clamp(local / 1.2))) * -50}px, 0, 0)` }}>
                <span>No. 0{on.index + 1}</span>
                <b>{words.features[on.index].verb}</b>
                <strong>{words.features[on.index].title}</strong>
                <em>{words.features[on.index].line}</em>
              </div>
              <div className="zine-photo" style={{ opacity: clamp(local * 5), transform: `rotate(${LAID[on.index].tilt + 7 * (1 - ease.outQuint(clamp(local / 1.4)))}deg) translate3d(${(1 - ease.outQuint(clamp(local / 1.4))) * 220}px, 0, 0) scale(${1.14 * (1 + 0.005 * pulse(q))})` }}>
                <i className="zine-tape" /><i className="zine-tape is-right" />
                <div className={`${LOOK === "dawn" ? "dawn" : "daybreak"} film-layer zine-print`}><Vignette id={words.features[on.index].key} u={on.u} lang={lang} /></div>
                {/* the pen goes round what matters, late in the bars */}
                <svg width={VG.w} height={VG.h} aria-hidden="true">
                  <ellipse cx={LAID[on.index].ring[0]} cy={LAID[on.index].ring[1]} rx={LAID[on.index].ring[2] / 2 + 26} ry={LAID[on.index].ring[3] / 2 + 22} pathLength={1} style={{ strokeDashoffset: 1 - ease.inOut(span(on.u, 5.2, 6.6)) }} transform={`rotate(-4 ${LAID[on.index].ring[0]} ${LAID[on.index].ring[1]})`} />
                </svg>
              </div>
            </div>
          )}
          {q >= bars.recap && leave < 1 && (
            <div className="zine-sheet" style={{ opacity: 1 - leave }}>
              {words.features.map((one, n) => (
                <figure key={one.key} style={{ transform: `rotate(${LAID[n].tilt}deg) scale(${ease.back(span(q, bars.recap + n * 0.3, bars.recap + 0.8 + n * 0.3))})` }}>
                  <div className={`${LOOK === "dawn" ? "dawn" : "daybreak"} film-layer zine-print`}><Vignette id={one.key} u={7.6} lang={lang} style={{ transform: `scale(${520 / VG.w})`, transformOrigin: "0 0" }} /></div>
                  <figcaption><b>{one.verb}</b>{one.title}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <End d={(q - bars.end - 0.3) * beat} f={WIDE} lang={lang} />
          {q >= bars.end + 4 && <p className="beat-facts zine-facts" style={{ opacity: clamp(q - bars.end - 4) }}>{words.facts.join(" · ")}</p>}
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => launchCues(song, bars)
  });
}
