import type { ReactNode } from "react";
import { film } from "../Film";
import { Ready } from "../free/Ready";
import { End } from "../Outro";
import { Caption } from "../parts";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { hit, pulse } from "./kit";
import { KEYS, KEYS_BEAT, KEYS_SECONDS, PRESSES, keysCues } from "./scripts";
import { KEY_WORDS } from "./words";

const OUT = KEYS.marks.out;
/** Each key's turn: the beat it starts on, how many beats it has, and what is on its caps. */
const TURNS: { from: number; beats: number; caps: string[] }[] = [
  { from: 4, beats: 4, caps: ["↵"] }, { from: 8, beats: 4, caps: ["↵"] }, { from: 12, beats: 8, caps: ["⌘", "K"] },
  { from: 20, beats: 8, caps: ["⌘", "D"] }, { from: 28, beats: 8, caps: ["Y"] }, { from: 36, beats: 8, caps: ["⌘", "Z"] }
];

/** What a key's turn shows beside it: a small drawing of what the key did, u beats into the turn. */
function demo(turn: number, u: number, lang: "en" | "zh"): ReactNode {
  const cards = (count: number, from: number) => Array.from({ length: count }, (_, i) => <i className="keys-card" key={i} style={{ transform: `scale(${ease.back(clamp((u - from) * 3 - i * 0.35))})` }} />);
  if (turn === 0) return <div className="keys-demo">{cards(1, 0.3)}</div>;
  if (turn === 1) return <div className="keys-demo">{cards(5, 0.3)}</div>;
  if (turn === 2) return <div className="keys-demo is-list">{(lang === "zh" ? ["APP-53  发票模型与编号", "docs/发票设计.md", "#会议纪要 11-12", "› 自动运行"] : ["APP-53  Invoice model", "docs/invoice-design.md", "#meeting notes 11-12", "› Auto run"]).map((row, i) => <span key={row} style={{ opacity: clamp((u - 0.5 - i * 1) * 4) }}>{row}</span>)}</div>;
  if (turn === 3) {
    const panes = u < 2 ? 2 : 4;
    return <div className={`keys-demo is-panes is-${panes}`}>{Array.from({ length: panes }, (_, i) => <i key={i} className={i === 2 ? "is-asking" : undefined} style={{ transform: `scale(${ease.back(clamp((u - (i < 2 ? 0.2 : 2.2)) * 4))})` }}><b /></i>)}</div>;
  }
  if (turn === 4) return <div className="keys-demo is-panes is-1"><i className={u < 2 ? "is-asking" : "is-done"} style={{ transform: `scale(${1 + 0.08 * hit(u, 2, 3)})` }}><b /></i></div>;
  // five tickets fold back into the one they were split from
  const back = ease.inOut(clamp((u - 2) * 1.6));
  return <div className="keys-demo">{Array.from({ length: 5 }, (_, i) => <i className="keys-card" key={i} style={{ marginLeft: i ? lerp(18, -128, back) : 0, opacity: i ? 1 - 0.85 * back : 1 }} />)}</div>;
}

/** "With Tomrade, it's a few keys.": large keycaps, one going down to a bar, and what each one does. */
export const keys = film<true>({
  id: "keys",
  shelf: "2-stories/keys",
  seconds: KEYS_SECONDS,
  poster: 13 * KEYS_BEAT,
  formats: ["wide"],
  bare: true,
  song: KEYS,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / KEYS_BEAT;
    const words = KEY_WORDS[lang];
    const turn = TURNS.findIndex((one) => q >= one.from && q < one.from + one.beats);
    const now = TURNS[turn];
    const down = Math.max(...PRESSES.map((at) => hit(q, at, 5)));
    const leave = ease.in(span(q, OUT - 0.4, OUT + 0.6));
    const merged = clamp(Math.floor((q - 48) * 2) + 1, 0, 8);
    return (
      <div className="keys" lang={lang} style={{ opacity: 1 }}>
        {q < 4 && (
          <>
            <Caption t={t} at={-1.5} until={4 * KEYS_BEAT} text={words.hook[0]} lang={lang} x={0} y={330} size={150} width={WIDE.w} align="center" />
            <Caption t={t} at={2 * KEYS_BEAT} until={4 * KEYS_BEAT} text={`*${words.hook[1]}*`} lang={lang} x={0} y={520} size={150} width={WIDE.w} align="center" />
          </>
        )}
        {now && (
          <div className="keys-turn" key={turn} style={{ transform: `scale(${1 + 0.008 * pulse(q)})` }}>
            <div className="keys-caps">{now.caps.map((cap) => <kbd key={cap} style={{ transform: `translate3d(0, ${22 * down}px, 0)`, boxShadow: `0 ${26 - 20 * down}px 0 #0d0b10, 0 ${44 - 30 * down}px 60px -10px rgb(0 0 0 / 0.7), inset 0 3px 0 rgb(255 255 255 / 0.14)` }}>{cap}</kbd>)}</div>
            <div className="keys-say" style={{ transform: `translate3d(${(1 - ease.outQuint(span(q, now.from, now.from + 0.6))) * 60}px, 0, 0)`, opacity: clamp((q - now.from) * 5) }}>
              <b>{words.slots[turn].title}</b>
              <span>{words.slots[turn].sub}</span>
              {demo(turn, q - now.from, lang)}
            </div>
          </div>
        )}
        {q >= 44 && leave < 1 && (
          <div className="keys-rest" style={{ opacity: 1 - leave }}>
            <Caption t={t} at={44 * KEYS_BEAT} until={OUT * KEYS_BEAT} text={words.rest} lang={lang} x={0} y={300} size={118} width={WIDE.w} align="center" />
            <p style={{ opacity: span(q, 46, 47) }}>{words.night}</p>
            <b className="num" style={{ opacity: span(q, 47.5, 48), transform: `scale(${1 + 0.14 * hit(q, 48 + (merged - 1) / 2, 4)})` }}>{words.merged} {merged}/8</b>
          </div>
        )}
        <End d={(q - OUT - 0.5) * KEYS_BEAT} f={WIDE} lang={lang} />
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: keysCues
});
