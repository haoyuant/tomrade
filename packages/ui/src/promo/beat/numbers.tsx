import { film } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { pulse } from "./kit";
import { NUMBERS, NUMBERS_BEAT, NUMBERS_SECONDS, numbersCues } from "./scripts";
import { NUMBER_WORDS } from "./words";

const OUT = NUMBERS.marks.out;

/** "Tomrade, by the numbers.": one large number to a bar, what it counts, and a line under it. */
export const numbers = film<true>({
  id: "numbers",
  shelf: "2-stories/numbers",
  seconds: NUMBERS_SECONDS,
  poster: 29 * NUMBERS_BEAT,
  formats: ["wide"],
  bare: true,
  song: NUMBERS,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / NUMBERS_BEAT;
    const words = NUMBER_WORDS[lang];
    const slot = Math.floor((q - 4) / 4);
    const u = q - 4 - slot * 4;
    const now = q >= 4 && slot < words.slots.length ? words.slots[slot] : null;
    // the eight pull requests are counted up, one to a half beat; every other number lands whole
    const figure = now ? (now[0] === "8" ? String(clamp(Math.floor(u * 2.5) + 1, 1, 8)) : now[0]) : "";
    const roll = ease.outQuint(clamp(u * 2.2));
    const zero = now?.[0] === "0";
    return (
      <div className={`numbers${zero ? " is-zero" : ""}`} lang={lang}>
        {q < 4 && <Caption t={t} at={-1.5} until={4 * NUMBERS_BEAT} text={words.hook} lang={lang} x={0} y={440} size={150} width={WIDE.w} align="center" />}
        {now && (
          <div className="numbers-slot" key={slot} style={{ transform: `scale(${1 + 0.012 * pulse(q)})` }}>
            <b style={{ transform: `translate3d(0, ${(1 - roll) * 46}%, 0) scale(${1.12 - 0.12 * roll})`, opacity: clamp(u * 9) }}>{figure}</b>
            <div>
              <strong style={{ opacity: clamp((u - 0.7) * 6), transform: `translate3d(${(1 - ease.outQuint(clamp((u - 0.7) * 2))) * 50}px, 0, 0)` }}>{now[1]}</strong>
              <span style={{ opacity: clamp((u - 1.6) * 5) }}>{now[2]}</span>
            </div>
          </div>
        )}
        <i className="numbers-ticks" style={{ ["--done" as string]: clamp((q - 4) / (OUT - 6)) }} />
        <End d={(q - OUT + 1.5) * NUMBERS_BEAT} f={WIDE} lang={lang} />
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: numbersCues
});
