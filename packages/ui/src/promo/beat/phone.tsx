import { film } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { Lines, hit } from "./kit";
import { MINE, PHONE, PHONE_BEAT, PHONE_SECONDS, SAID, phoneCues } from "./scripts";
import { PHONE_WORDS } from "./words";

const OUT = PHONE.marks.out;
/** The ticket at home: the beats it is filed, claimed, in review and merged, as the chat reports them. */
const HOME = [SAID[1], SAID[2], SAID[3], SAID[6]];

/** "You're out. Your computer is home.": a chat on a phone, and the computer at home doing what it says. */
export const phone = film<true>({
  id: "phone",
  seconds: PHONE_SECONDS,
  poster: 19 * PHONE_BEAT,
  formats: ["wide"],
  bare: true,
  song: PHONE,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / PHONE_BEAT;
    const words = PHONE_WORDS[lang];
    const leave = ease.in(span(q, OUT - 0.4, OUT + 0.6));
    const column = HOME.filter((at) => q >= at).length - 1;
    const asked = q >= SAID[4] && q < SAID[5];
    return (
      <div className="phone" lang={lang}>
        {leave < 1 && (
          <div className="phone-scene" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 120}px, 0)` }}>
            <div className="phone-body" style={{ transform: `rotate(-3deg) scale(${1 + 0.012 * Math.max(...SAID.map((at) => hit(q, at, 5)))})` }}>
              <div className="phone-head"><b>{words.name}</b><span>{words.apps}</span></div>
              <div className="phone-chat">
                {words.chat.map((line, n) => {
                  if (q < SAID[n]) return null;
                  const pop = ease.back(span(q, SAID[n], SAID[n] + 0.5));
                  return (
                    <div className={`phone-said${MINE.includes(n) ? " is-mine" : ""}`} key={n} style={{ transform: `scale(${0.6 + 0.4 * pop})`, opacity: clamp(pop * 2) }}>
                      {line}
                      {n === 4 && <span className="phone-choices">{words.merge.map((choice, k) => <i key={choice} className={k === 0 && !asked ? "is-picked" : undefined}>{choice}</i>)}</span>}
                    </div>
                  );
                })}
                {/* someone is typing: three dots that hop on the half beats before a message comes */}
                {SAID.some((at) => q >= at - 1 && q < at) && <div className="phone-said is-typing">{[0, 1, 2].map((k) => <i key={k} style={{ transform: `translate3d(0, ${-8 * Math.max(0, Math.sin((q * 2 - k * 0.3) * Math.PI))}px, 0)` }} />)}</div>}
              </div>
            </div>
            {/* the computer at home: the ticket the chat is about, moving as the chat says it does */}
            <div className="phone-home" style={{ opacity: span(q, SAID[1] - 0.5, SAID[1] + 0.5) }}>
              <b>{words.home}</b>
              <div>{words.columns.map((name, n) => <span key={name} className={n === column ? "is-here" : undefined}>{name}{n === column && <i style={{ transform: `scale(${1 + 0.25 * hit(q, HOME[n], 3)})` }}>APP-61</i>}</span>)}</div>
            </div>
          </div>
        )}
        <Lines t={t} beat={PHONE_BEAT} lines={words.lines.map(([text, from, until]) => [text.replace("，*", "，\n*").replace(". *", ".\n*").replace(": *", ":\n*").replace("：*", "：\n*"), from, until])} lang={lang} x={760} y={150} size={80} width={1100} flat={false} />
        <End d={(q - OUT - 0.5) * PHONE_BEAT} f={WIDE} lang={lang} />
        {q >= OUT + 5 && <p className="beat-facts" style={{ opacity: clamp(q - OUT - 5) }}>{words.facts}</p>}
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: phoneCues
});
