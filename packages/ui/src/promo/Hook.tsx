import { flight, type Measures, type Paths } from "./Board";
import { Caption } from "./parts";
import { PANE_AT, type Format } from "./stage";
import { T, clamp, ease, noise, span } from "./time";
import { CAPTIONS, CODE_WORDS, PANES, type Lang } from "./words";

/** A terminal's height against its width. */
const RATIO = 0.36;

/**
 * The opening: terminals pile up, each one stopped on a question for the person. Then each folds into the ticket it
 * was working on and flies to the board.
 */
export function Hook({ t, f, lang, at, measures }: { t: number; f: Format; lang: Lang; at: Paths; measures: Measures }) {
  if (t > T.board + 0.6) return null;
  const words = CAPTIONS[lang];
  const arrived = PANE_AT.filter((born) => t >= born).length;
  // Each arrival knocks the pile, less each moment after.
  const knock = (axis: number) => PANE_AT.reduce((sum, born, n) => (t < born ? sum : sum + Math.exp(-(t - born) * 11) * 9 * Math.sin((t - born) * 58 + n * 2 + axis)), 0);
  const line = f.hook.size * 1.1;
  const out = T.turn + 0.12;
  const count = arrived > 0 && t < T.turn + 0.3;
  const bump = arrived > 0 ? 1 + 0.16 * Math.exp(-(t - PANE_AT[arrived - 1]) * 9) : 1;
  return (
    <>
      <div className="film-pile" style={{ transform: `translate3d(${knock(0)}px, ${knock(1.7)}px, 0)` }}>
        {PANES[lang].map((pane, n) => {
          const born = PANE_AT[n];
          if (t < born) return null;
          const fly = flight(n, t, f, at, measures);
          if (fly.card >= 1) return null;
          const land = ease.back(span(t, born, born + 0.42));
          const w = f.pane.w;
          const h = w * RATIO;
          // The caret blinks out of step from one terminal to the next.
          const caret = Math.floor((t - born) * 2.4 + noise(n) * 2) % 2 === 0;
          return (
            <div className="film-pane" key={n} style={{ left: fly.x - w / 2, top: fly.y - h / 2 + (1 - land) * 60, width: w, height: h, fontSize: w / 36, opacity: clamp(span(t, born, born + 0.1)) * (1 - fly.card), transform: `rotate(${fly.tilt}deg) scale(${fly.scale * (0.82 + 0.18 * land)})`, zIndex: n }}>
              <div className="film-pane-head">
                <i className="film-pane-dot" />
                <span>{pane.title}</span>
                <span className="film-pane-state">{CODE_WORDS[lang].waitingForYou}</span>
              </div>
              <div className="film-pane-log">
                {pane.log.map((row) => <div key={row}><b>✓</b>{row}</div>)}
              </div>
              <div className="film-pane-ask">{pane.ask}<i className="film-pane-caret" style={{ opacity: caret ? 1 : 0 }} /></div>
            </div>
          );
        })}
      </div>
      {count && (
        <div className="film-count" style={{ left: f.pane.count[0], top: f.pane.count[1], opacity: 1 - span(t, T.turn, T.turn + 0.25), transform: `translate(-50%, -50%) scale(${bump})` }}>
          <i />
          <span className="num">{arrived}</span>
          <span>{CODE_WORDS[lang].waitingForYou}</span>
        </div>
      )}
      <Caption t={t} at={-0.3} until={out} text={words.hook1} lang={lang} x={f.hook.x} y={f.hook.y} size={f.hook.size} width={f.w} />
      <Caption t={t} at={1.5} until={out} text={words.hook2} lang={lang} x={f.hook.x} y={f.hook.y + line} size={f.hook.size} width={f.w} />
      <Caption t={t} at={2.5} until={out} text={words.hook3} lang={lang} x={f.hook.x} y={f.hook.y + 2 * line} size={f.hook.size} width={f.w} />
    </>
  );
}
