import { BANNER } from "../beat/tty";
import { pulse } from "../beat/kit";
import { film, type FilmDef } from "../Film";
import { Ready } from "../free/Ready";
import { clamp, ease, span } from "../time";
import { featureAt, launchCues, secondsOf, songOf, type Bars } from "./scripts";
import { Vignette } from "./vignettes";
import { LAUNCH } from "./words";

const typed = (text: string, q: number, at: number, per = 0.18): string => [...text].slice(0, clamp(Math.floor((q - at) / per) + 1, 0, [...text].length)).join("");

/** The manual page: `man tomrade` on the left, option by option, and what each option does playing on the right. */
export function manual(id: string, bars: Bars): FilmDef {
  const song = songOf("manual", bars);
  const beat = 60 / song.bpm;
  return film<true>({
    id,
    shelf: "1-launch/manual",
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
      const half = bars.define / 2;
      const ended = q >= bars.end;
      const blink = Math.floor(q * 2) % 2 === 0;
      return (
        <div className="tty man" lang={lang}>
          <div className="tty-screen" style={{ transform: `scale(${1 + 0.006 * pulse(q, 6)})` }}>
            {q < bars.define && (
              <div className="man-hook">
                <div><b className="tty-dim">$ </b>{typed("whoami", q, 0.2)}</div>
                {q >= 1.6 && <div className="tty-amber man-big">{lang === "zh" ? "保姆" : "babysitter"}</div>}
                {q >= half && <div><b className="tty-dim">$ </b>{typed("man tomrade", q, half + 0.2)}{blink && <i className="tty-cursor" />}</div>}
              </div>
            )}
            {q >= bars.define && !ended && (
              <>
                <div className="tty-dim">TOMRADE(1)</div>
                <div className="man-head">NAME</div>
                <div className="man-name"><b>tomrade</b> — {typed(words.define, q, bars.define + 0.4, 0.14)}</div>
                {q >= bars.define + 3.4 && q < bars.features && <div className="tty-dim man-more">{words.defineMore}</div>}
                {q >= bars.features - 0.6 && (
                  <>
                    <div className="man-head">OPTIONS</div>
                    {words.features.map((one, n) => {
                      const state = !on ? "is-done" : n === on.index ? "is-on" : n < on.index ? "is-done" : "";
                      return <div className={`man-option ${state}`} key={one.key}><b>--{one.key.padEnd(6)}</b>{one.title}{state === "is-done" && <i> ✓</i>}</div>;
                    })}
                    {q >= bars.recap && <><div className="man-head">SEE ALSO</div><div className="tty-amber">{words.site} · {words.facts.slice(0, 3).join(" · ")}</div></>}
                  </>
                )}
              </>
            )}
            {on && (
              <div className="man-pane" key={on.index} style={{ opacity: clamp(((q - bars.features) % bars.each) * 5) }}>
                <div className="man-pane-bar">tomrade --{words.features[on.index].key}</div>
                <div className="man-pane-body"><Vignette id={words.features[on.index].key} u={on.u} lang={lang} /></div>
                <div className="man-pane-foot">{words.features[on.index].line}</div>
              </div>
            )}
            {ended && (
              <div className="tty-end" style={{ transform: `scale(${0.96 + 0.04 * ease.back(span(q, bars.end, bars.end + 0.8))})` }}>
                <div className="tty-banner"><pre>{BANNER.join("\n")}</pre></div>
                <div>{words.define}</div>
                {q >= bars.end + 2 && <div className="tty-amber tty-big">{words.get} · {words.site}{blink && <i className="tty-cursor" />}</div>}
                {q >= bars.end + 4 && <div className="tty-dim">{words.facts.join(" · ")}</div>}
              </div>
            )}
          </div>
          <i className="tty-lines" aria-hidden="true" />
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => launchCues(song, bars)
  });
}
