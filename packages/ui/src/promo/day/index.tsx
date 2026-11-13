import { film, type FilmDef } from "../Film";
import { End, Proof } from "../Outro";
import { Caption } from "../parts";
import { ease, span } from "../time";
import { Measure, type Board } from "../Window";
import { CUTS, cuesOf, pointerOf, spanOf, type Cut } from "./cuts";
import { Day } from "./Day";
import { AGE, D, PLAN, clock, day, rise, skyTime } from "./story";
import { CAPTIONS, TICKETS } from "./words";

/** A cut as a film: the picture is the same function of the day's time in every one of them. */
function filmOf(cut: Cut): FilmDef {
  const { from, lines } = cut;
  const { shown, endAt, seconds } = spanOf(cut);
  return film<Board>({
    id: cut.id,
    seconds,
    poster: cut.poster - from,
    day: (t) => day(from + t),
    // Behind the end the sun stands higher still.
    rise: (t) => rise(from + t) + 0.25 * ease.inOut(span(t, endAt, endAt + 1.4)),
    skyTime: (t) => skyTime(from + t),
    Prepare: ({ lang, onDone }) => <Measure plans={PLAN} words={TICKETS[lang]} lang={lang} clock={clock} age={AGE} t={D.out} onDone={onDone} />,
    Picture: ({ t, f, lang, prepared }) => {
      const words = CAPTIONS[lang];
      return (
        <>
          <Day t={from + t} f={f} lang={lang} board={prepared} leave={ease.in(span(t, shown - 0.1, shown + 0.5))} />
          {/* a caption that starts with the film is already up on its first frame, which is what a feed shows before it plays */}
          {lines.map(([key, a, b]) => (
            <Caption key={key} t={t} at={a <= from ? -1.5 : a - from} until={Math.min(b - from, shown)} text={words[key]} lang={lang} x={f.caption.x} y={f.caption.y} size={f.caption.size} width={f.caption.width} flat={f.id === "wide"} />
          ))}
          {cut.facts && <Proof t={t} from={shown + 0.2} until={endAt} texts={[words.fact1, words.fact2, words.fact3]} f={f} lang={lang} />}
          <End d={t - endAt} f={f} lang={lang} />
        </>
      );
    },
    pointer: pointerOf(cut),
    cues: (lang) => cuesOf(cut, lang)
  });
}

/** The main film and the short ones cut from its day. */
export const DAY_FILMS: FilmDef[] = CUTS.map(filmOf);
