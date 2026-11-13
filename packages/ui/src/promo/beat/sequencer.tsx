import { film } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { Lines, hit, pulse } from "./kit";
import { PAD, PADS, SEQUENCER, SEQUENCER_BEAT, SEQUENCER_SECONDS, padRow, playhead, sequencerCues } from "./scripts";
import { SEQ_WORDS } from "./words";

const OUT = SEQUENCER.marks.out;

/** "Say one sentence.": the board as a drum machine; a ticket is a pad that sounds when the playhead crosses it. */
export const sequencer = film<true>({
  id: "sequencer",
  seconds: SEQUENCER_SECONDS,
  poster: 22 * SEQUENCER_BEAT,
  formats: ["wide"],
  bare: true,
  song: SEQUENCER,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / SEQUENCER_BEAT;
    const words = SEQ_WORDS[lang];
    const head = Math.floor(playhead(q));
    const night = ease.inOut(span(q, 31, 33)) * (1 - ease.inOut(span(q, 43, 44.5)));
    const merged = PAD.filter((pad) => q >= pad.merge).length;
    const leave = ease.in(span(q, OUT - 0.4, OUT + 0.6));
    const waiting = q >= PADS.ask && q < PADS.tap;
    return (
      <div className="seq" lang={lang} style={{ ["--night" as string]: night }}>
        {leave < 1 && (
          <div className="seq-box" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 120}px, 0) scale(${1 + 0.006 * pulse(q) - 0.04 * leave})` }}>
            {words.rows.map((name, row) => (
              <div className="seq-row" key={name}>
                <b>{name}</b>
                {Array.from({ length: 16 }, (_, col) => {
                  const i = col / 2;
                  const mine = col % 2 === 0 && q >= PAD[i].on && padRow(i, q) === row;
                  const pad = mine ? PAD[i] : null;
                  const moved = pad ? [pad.on, pad.claim, pad.pr, pad.merge][row] : 0;
                  const asks = mine && i === PADS.asks && waiting;
                  // a pad flashes when it lands in its row, and again each time the playhead crosses it
                  const flash = mine ? Math.max(hit(q, moved, 3), col === head ? 1 - (playhead(q) - head) : 0, q >= PADS.stop ? pulse(q, 3) : 0) : 0;
                  return <i key={col} className={`${mine ? `is-on is-row${row}` : ""}${asks ? " is-asking" : ""}${col === head ? " is-under" : ""}${col % 4 === 0 ? " is-bar" : ""}`} style={mine ? { transform: `scale(${1 + 0.1 * flash})`, ["--flash" as string]: asks ? 0.5 + 0.5 * Math.sin(q * Math.PI * 4) : flash } : undefined} />;
                })}
              </div>
            ))}
            <div className="seq-foot">
              <span className="num">▶ {SEQUENCER.bpm} BPM</span>
              <span className={`seq-led${q >= 32 && q < PADS.stop ? " is-on" : ""}`}><i />{words.run}</span>
              <span style={{ flex: 1 }} />
              <span className="num seq-count" style={{ transform: `scale(${1 + 0.2 * Math.max(...PAD.map((pad) => hit(q, pad.merge, 3)))})` }}>{words.merged} {merged}/8</span>
            </div>
            {waiting && <div className="seq-tap" style={{ left: 300 + PADS.asks * 2 * 90 + 39, transform: `translate(-50%, 0) scale(${1 + 0.08 * Math.sin(q * Math.PI * 4)})` }}>?</div>}
          </div>
        )}
        <Lines t={t} beat={SEQUENCER_BEAT} lines={words.lines} lang={lang} y={52} />
        <End d={(q - OUT - 0.5) * SEQUENCER_BEAT} f={WIDE} lang={lang} />
        {q >= OUT + 5 && <p className="beat-facts" style={{ opacity: clamp(q - OUT - 5) }}>{words.facts}</p>}
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: sequencerCues
});
