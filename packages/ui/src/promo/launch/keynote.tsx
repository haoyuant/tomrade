import { hit, pulse } from "../beat/kit";
import { film, type FilmDef } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { featureAt, launchCues, secondsOf, songOf, type Bars } from "./scripts";
import { VG, Vignette } from "./vignettes";
import { LAUNCH } from "./words";

/** The keynote: a dark stage, large type, and the app's pieces brought on one at a time; then all six at once. */
export function keynote(id: string, bars: Bars): FilmDef {
  const song = songOf("keynote", bars);
  const beat = 60 / song.bpm;
  return film<true>({
    id,
    shelf: "1-launch/keynote",
    seconds: secondsOf(song),
    poster: (bars.features + 2.5 * bars.each) * beat,
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
      const local = on ? (q - bars.features) % bars.each : 0;
      return (
        <div className="keynote" lang={lang}>
          <i className="keynote-light" style={{ opacity: 0.7 + 0.3 * pulse(q, 3) }} />
          {q < bars.define && (
            <>
              <Caption t={t} at={-1.5} until={bars.define * beat} text={words.hook[0]} lang={lang} x={0} y={330} size={128} width={WIDE.w} align="center" />
              <Caption t={t} at={(bars.define / 2) * beat} until={bars.define * beat} text={words.hook[1]} lang={lang} x={0} y={500} size={128} width={WIDE.w} align="center" />
            </>
          )}
          {q >= bars.define && q < bars.features && (
            <div className="keynote-define" style={{ transform: `scale(${1 + 0.02 * hit(q, bars.define, 3)})` }}>
              <i className="film-sun keynote-sun" style={{ transform: `scale(${ease.back(span(q, bars.define, bars.define + 0.8))})` }}><i className="film-sun-cat" /></i>
              <b style={{ opacity: clamp((q - bars.define - 0.4) * 4) }}>{words.name}</b>
              <strong style={{ opacity: clamp((q - bars.define - 1.5) * 3) }}>{words.define}</strong>
              <span style={{ opacity: clamp((q - bars.define - 3.5) * 3) }}>{words.defineMore}</span>
            </div>
          )}
          {on && (
            <div className="keynote-feature" key={on.index}>
              <div className="keynote-words" style={{ opacity: clamp(local * 5), transform: `translate3d(${(1 - ease.outQuint(clamp(local / 1.2))) * -60}px, 0, 0)` }}>
                <b>{words.features[on.index].verb}</b>
                <div><strong>{words.features[on.index].title}</strong><em>{words.features[on.index].line}</em></div>
                <span className="num">0{on.index + 1} / 06</span>
              </div>
              <div className="keynote-card" style={{ opacity: clamp(local * 4), transform: `perspective(2600px) rotateX(${10 * (1 - ease.outQuint(clamp(local / 1.4)))}deg) translate3d(0, ${(1 - ease.outQuint(clamp(local / 1.4))) * 160}px, 0) scale(${1.4 * (1 + 0.006 * pulse(q))})` }}>
                <Vignette id={words.features[on.index].key} u={on.u} lang={lang} />
              </div>
            </div>
          )}
          {q >= bars.recap && leave < 1 && (
            <div className="keynote-all" style={{ opacity: 1 - leave }}>
              {words.features.map((one, n) => (
                <figure key={one.key} style={{ transform: `scale(${ease.back(span(q, bars.recap + n * 0.3, bars.recap + 0.8 + n * 0.3))})` }}>
                  <div><Vignette id={one.key} u={7.6} lang={lang} style={{ transform: `scale(${560 / VG.w})`, transformOrigin: "0 0" }} /></div>
                  <figcaption><b>{one.verb}</b>{one.title}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <End d={(q - bars.end - 0.3) * beat} f={WIDE} lang={lang} />
          {q >= bars.end + 4 && <p className="beat-facts" style={{ opacity: clamp(q - bars.end - 4) }}>{words.facts.join(" · ")}</p>}
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => launchCues(song, bars)
  });
}
