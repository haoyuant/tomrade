import type { ReactNode } from "react";
import { film } from "../Film";
import { Ready } from "../free/Ready";
import { clamp, noise, span } from "../time";
import { OUTRO, type Lang } from "../words";
import { ASKS, BOARD, STROKE, TTY, TTY_BEAT, TTY_SECONDS, TYPED, ttyCues } from "./scripts";
import { TTY_WORDS } from "./words";

/** The name in block letters, five rows of it. */
const LETTERS: Record<string, string[]> = {
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "], O: [" ███ ", "█   █", "█   █", "█   █", " ███ "], M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"], A: [" ███ ", "█   █", "█████", "█   █", "█   █"], D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"]
};
const BANNER = [0, 1, 2, 3, 4].map((row) => [..."TOMRADE"].map((letter) => LETTERS[letter][row]).join("  "));
const AGENTS = ["claude", "codex"];

/** A command as far as it has been typed by beat q, with the cursor after it while it is the last thing on screen. */
function Typed({ q, at, text, cursor = true }: { q: number; at: number; text: string; cursor?: boolean }) {
  const shown = clamp(Math.floor((q - at) / STROKE) + 1, 0, text.length);
  return <div><b className="tty-dim">$ </b>{text.slice(0, shown)}{cursor && <i className="tty-cursor" style={{ opacity: shown < text.length || Math.floor(q * 2) % 2 === 0 ? 1 : 0 }} />}</div>;
}

function screen(q: number, lang: Lang): ReactNode {
  const words = TTY_WORDS[lang];
  const blink = Math.floor(q) % 4 === 3 ? "-.-" : "o.o";
  const cat = (face: string) => <pre className="tty-cat">{` /\\_/\\\n( ${face} )\n > ^ <`}</pre>;

  if (q < 17) {
    // who am I: the one every agent is waiting on
    const rows = q < 6 ? 0 : q < 8 ? Math.floor((q - 6) * 1) + 1 : Math.floor((q - 8) * 2) + 3;
    const lines = Array.from({ length: rows }, (_, i) => <div className="tty-red" key={i}>{AGENTS[i % 2].padEnd(8)}APP-{41 + i}  {words.waits}</div>);
    return (
      <>
        <Typed q={q} at={TYPED.who} text="whoami" cursor={q < 2} />
        {q >= 2 && <div className="tty-amber">{words.who}</div>}
        {q >= TYPED.status && <Typed q={q} at={TYPED.status} text="agents status" cursor={q < 6} />}
        {lines.slice(-8)}
        {q >= 16 && <div>^C</div>}
        {rows > 0 && <div className="tty-count" style={{ transform: `scale(${1 + 0.12 * Math.exp(-((q * 2) % 1) * 4)})` }}><b>{rows}</b><span>{words.count}</span></div>}
      </>
    );
  }
  if (q < 28) {
    const rows = clamp(Math.floor((q - 20) * 2) + 1, 0, 5);
    return (
      <>
        <Typed q={q} at={TYPED.run} text="tomrade" cursor={q < 20} />
        {q >= 20 && <div className="tty-banner"><pre>{BANNER.slice(0, rows).join("\n")}</pre>{q >= 22.5 && cat(blink)}</div>}
        {q >= 24 && <div className="tty-dim">{words.facts.slice(0, clamp(Math.floor((q - 24) * 14), 0, words.facts.length))}</div>}
      </>
    );
  }
  if (q < 56) {
    // the board: a ticket is a token that moves a column when its agent says so
    const stage = (i: number) => (q >= BOARD[i].merge ? 3 : q >= BOARD[i].pr ? 2 : q >= BOARD[i].claim ? 1 : 0);
    const asking = q >= 39 && q < 43;
    const merged = BOARD.filter((ticket) => q >= ticket.merge).length;
    const events = BOARD.flatMap((ticket, i) => [
      { at: ticket.claim, text: `${AGENTS[i % 2]} ${words.claim} APP-${53 + i}`, good: false },
      { at: ticket.pr, text: `${AGENTS[i % 2]} ${words.pr} #${231 + i}`, good: false },
      { at: ticket.merge, text: `#${231 + i} ${words.merge} ✓`, good: true }
    ]).filter((event) => event.at <= q).sort((a, b) => a.at - b.at);
    const won = q >= 52;
    return (
      <>
        <div className="tty-dim">{words.notes[q < 36 ? 0 : q < 44 ? 1 : 2]}</div>
        <div className="tty-board">
          {words.columns.map((name, column) => (
            <div key={name}>
              <b>{name}</b>
              {BOARD.map((ticket, i) => {
                if (stage(i) !== column) return null;
                const moved = [0, ticket.claim, ticket.pr, ticket.merge][column];
                return <span key={i} className={i === ASKS && asking ? "tty-amber" : column === 3 ? "tty-green" : undefined} style={{ transform: `scale(${1 + 0.25 * Math.exp(-(q - moved) * 3)})` }}>[{53 + i}{i === ASKS && asking ? "?" : ""}]</span>;
              })}
            </div>
          ))}
        </div>
        <div className={won ? "tty-green tty-big" : undefined}>[{"█".repeat(merged * 3)}{"░".repeat((8 - merged) * 3)}] {merged}/8 {words.merged}</div>
        {won ? cat("^.^") : (
          <>
            {events.slice(-3).map((event) => <div key={event.text} className={event.good ? "tty-green" : "tty-dim"}>{event.text}</div>)}
            {q >= 39 && q < 44 && <div className="tty-amber">{words.ask}{q >= TYPED.answer ? "1" : ""}{q < 43 && <i className="tty-cursor" style={{ opacity: Math.floor(q * 2) % 2 === 0 ? 1 : 0 }} />}</div>}
          </>
        )}
      </>
    );
  }
  if (q < 64) {
    return (
      <>
        <Typed q={q} at={TYPED.again} text="whoami" cursor={q < 58} />
        {q >= 58 && <div className="tty-green tty-big">{words.after}</div>}
        {q >= 60 && <Typed q={q} at={99} text="" />}
      </>
    );
  }
  const outro = OUTRO[lang];
  return (
    <div className="tty-end">
      <div className="tty-banner"><pre>{BANNER.join("\n")}</pre>{cat(blink)}</div>
      <div>{outro.tagline.replace("\n", lang === "zh" ? "" : " ")}</div>
      {q >= 66 && <div className="tty-amber tty-big">{outro.get}<i className="tty-cursor" style={{ opacity: Math.floor(q * 2) % 2 === 0 ? 1 : 0 }} /></div>}
    </div>
  );
}

/** "$ whoami": the whole frame is a terminal, and the story is typed into it. */
export const tty = film<true>({
  id: "tty",
  seconds: TTY_SECONDS,
  poster: 13 * TTY_BEAT,
  formats: ["wide"],
  bare: true,
  song: TTY,
  day: () => 0,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / TTY_BEAT;
    // the screen shakes as the questions pile up, and jumps a little on every beat
    const panic = span(q, 9, 16) * (q < 17 ? 1 : 0);
    const jump = 1 + 0.008 * Math.exp(-(q - Math.floor(q)) * 6);
    return (
      <div className="tty" lang={lang}>
        <div className="tty-screen" style={{ transform: `translate3d(${(noise(Math.floor(q * 8), 1) - 0.5) * 22 * panic}px, ${(noise(Math.floor(q * 8), 2) - 0.5) * 16 * panic}px, 0) scale(${jump})` }}>{screen(q, lang)}</div>
        <i className="tty-lines" aria-hidden="true" />
      </div>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: ttyCues
});
