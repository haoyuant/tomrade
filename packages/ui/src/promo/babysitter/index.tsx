import { film } from "../Film";
import { End, Proof } from "../Outro";
import { Caption } from "../parts";
import { ease, span, track } from "../time";
import type { Board } from "../Window";
import { BoardScene, Measure } from "./Board";
import { POINTER, cues } from "./cues";
import { Hook } from "./Hook";
import { T, dawn, skyTime } from "./stage";
import { CAPTIONS, type CaptionKey } from "./words";

/** The captions over the board, each from its second to the next one's. */
const OVER_BOARD: [CaptionKey, number, number][] = [
  ["meet", T.turn + 0.35, 5.52],
  ["claim", 5.6, 7.42],
  ["build", 7.5, 8.98],
  ["report", 9.06, T.ask],
  ["ask", T.ask + 0.1, 13.45],
  ["bed", T.night, 16.5],
  ["wake", 16.7, T.proof - 0.05]
];

/**
 * "So many agents. One babysitter. You.": terminals pile up, each stopped on a question; they fold into tickets on
 * the board, the agents work through them, one question is answered, and an auto run finishes the rest by morning.
 */
export const babysitter = film<Board>({
  id: "babysitter",
  seconds: T.total,
  poster: 3.2,
  day: dawn,
  // The sun is down all night, up at dawn, higher still behind the end.
  rise: (t) => track(t, [[0, 0.12], [T.dawn - 0.4, 0.12], [T.dawn + 2.3, 1], [T.end, 1], [T.end + 1.4, 1.25]]),
  skyTime,
  Prepare: Measure,
  Picture: ({ t, f, lang, prepared: { measures, at } }) => {
    const words = CAPTIONS[lang];
    return (
      <>
        <Hook t={t} f={f} lang={lang} at={at} measures={measures} />
        <BoardScene t={t} f={f} lang={lang} at={at} measures={measures} />
        {OVER_BOARD.map(([key, from, until]) => (
          <Caption key={key} t={t} at={from} until={until} text={words[key]} lang={lang} x={f.caption.x} y={f.caption.y} size={f.caption.size} width={f.caption.width} flat={f.id === "wide"} />
        ))}
        {t >= T.turn + 0.3 && t < 5.6 && (
          <i className="film-horizon" style={{ left: f.caption.x, top: f.caption.y + f.caption.size * 1.24, width: f.caption.size * 6.6, transformOrigin: "0 50%", transform: `scaleX(${ease.outQuint(span(t, T.turn + 0.45, T.turn + 1.25))})`, opacity: 1 - span(t, 5.3, 5.56) }} />
        )}
        <Proof t={t} from={T.proof} until={T.end} texts={[words.proof1, words.proof2, words.proof3]} f={f} lang={lang} />
        <End d={t - T.end} f={f} lang={lang} />
      </>
    );
  },
  pointer: POINTER,
  cues
});
