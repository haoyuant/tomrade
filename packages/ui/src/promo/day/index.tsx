import { film, type Cue, type FilmDef } from "../Film";
import { END_SECONDS, End, Proof, proofAt } from "../Outro";
import { Caption } from "../parts";
import { COLUMNS } from "../sim";
import { ease, span } from "../time";
import { Measure, type Board } from "../Window";
import type { Lang } from "../words";
import { keysAt } from "./Chat";
import { Day } from "./Day";
import { AGE, D, PLAN, POINTER, REDO, clock, day, rise, skyTime } from "./story";
import { LINES } from "./Terminal";
import { CAPTIONS, TICKETS, type CaptionKey } from "./words";

/** A caption over the day, from one of its seconds to another. */
type Line = [CaptionKey, number, number];
/** How long the facts after the main film stay up. */
const FACTS = 5.2;

/** What is heard through the day, at the day's own seconds. */
function heard(lang: Lang): Cue[] {
  return [
    ...keysAt(lang).map((at, n) => ({ at, kind: "key" as const, n })),
    ...[D.send, D.tidy].map((at, n) => ({ at, kind: "send" as const, n })),
    { at: D.ticket, kind: "card" as const, n: 0 },
    ...[1, 2, 3, 4, 5].map((n) => ({ at: D.split + (n - 1) * 0.07, kind: "card" as const, n })),
    { at: D.revert, kind: "back" as const, n: 0 },
    ...REDO.slice(0, 5).map((at, n) => ({ at, kind: "card" as const, n: n + 1 })),
    ...POINTER.clicks.map((at) => ({ at, kind: "click" as const, n: 0 })),
    ...[D.build, D.merge + 0.35].map((at, n) => ({ at, kind: "swap" as const, n })),
    ...[LINES.claude, LINES.codex].flatMap((lines, pane) => lines.slice(1).map((at) => ({ at, kind: "line" as const, n: pane }))),
    // a card's note says how far along the board it lands
    ...PLAN.flatMap((plan, n) => plan.moves.map((move) => ({ at: move.at, kind: "hop" as const, n: COLUMNS.indexOf(move.to) * 3 + (n % 3) }))),
    { at: D.ask + 0.2, kind: "ask" as const, n: 0 },
    { at: D.run, kind: "run" as const, n: 0 },
    { at: D.dusk, kind: "dusk" as const, n: 0 },
    { at: D.dawn, kind: "dawn" as const, n: 0 },
    { at: D.morning, kind: "morning" as const, n: 0 }
  ];
}

/**
 * A film cut from the day: its seconds from `from` to `to` under the film's own captions, then the facts if it has
 * them, then the end card. The picture is the same function of the day's time in every cut.
 */
function cut({ id, from, to, poster, lines, facts = false }: { id: string; from: number; to: number; /** The day's second its still is taken at. */ poster: number; lines: Line[]; facts?: boolean }): FilmDef {
  const shown = to - from;
  const endAt = shown + (facts ? FACTS : 0);
  const seconds = endAt + END_SECONDS;
  return film<Board>({
    id,
    seconds,
    poster: poster - from,
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
          {facts && <Proof t={t} from={shown + 0.2} until={endAt} texts={[words.fact1, words.fact2, words.fact3]} f={f} lang={lang} />}
          <End d={t - endAt} f={f} lang={lang} />
        </>
      );
    },
    pointer: {
      route: POINTER.route.map((stop) => ({ ...stop, at: stop.at - from })),
      clicks: POINTER.clicks.map((at) => at - from).filter((at) => at >= 0 && at < shown),
      until: shown
    },
    cues: (lang) => [
      { at: 0, kind: "day" as const, n: 0 },
      ...heard(lang).map((cue) => ({ ...cue, at: cue.at - from })).filter((cue) => cue.at >= 0 && cue.at < shown),
      ...(facts ? proofAt(shown + 0.2, endAt, 3).map((at, n) => ({ at, kind: "fact" as const, n })) : []),
      { at: endAt, kind: "end" as const, n: 0 }
    ].sort((a, b) => a.at - b.at)
  });
}

/** The main film: one sentence becomes tickets, agents build them in the person's own terminal, and an auto run merges them overnight. */
export const main = cut({
  id: "main", from: 0, to: D.out, poster: 19, facts: true,
  lines: [
    ["open", -0.3, D.send + 0.9], ["talk", D.send + 1, D.tidy - 0.3], ["split", D.tidy - 0.2, D.revert - 1.3], ["back", D.revert - 1.2, D.build - 0.2],
    ["build", D.build - 0.1, 17.2], ["keeps", 17.3, D.ask - 0.1], ["ask", D.ask, D.merge - 0.1],
    ["merge", D.merge, D.run + 0.9], ["graph", D.run + 1, 32.4], ["checks", 32.5, D.dawn + 1.9], ["morning", D.morning, D.out]
  ]
});

/** Short films, each one stretch of the same day with its own words. */
export const idea = cut({ id: "idea", from: 0, to: 9.9, poster: 9, lines: [["open", -0.3, D.send + 0.9], ["ideaTicket", D.send + 1, D.tidy - 0.3], ["ideaSplit", D.tidy - 0.2, 9.9]] });
export const undo = cut({ id: "undo", from: 6.3, to: 13.8, poster: 9, lines: [["undoRewrote", 6, D.revert - 1.3], ["undoBack", D.revert - 1.2, D.redo - 0.3], ["undoForth", D.redo - 0.2, 13.8]] });
export const handsfree = cut({ id: "handsfree", from: 14.5, to: 21.1, poster: 19, lines: [["boardNobody", 14.1, 16.3], ["boardAgents", 16.4, 18.7], ["keeps", 18.8, 21.1]] });
export const overnight = cut({ id: "overnight", from: 27, to: 40.9, poster: 34, lines: [["nightBed", 26.7, D.run + 1.1], ["graph", D.run + 1.2, 32.4], ["checks", 32.5, D.dawn + 1.9], ["morning", D.morning, 40.9]] });
