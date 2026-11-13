import type { CSSProperties, ReactNode } from "react";
import { Icon } from "~/components/icons";
import { say } from "~/lib/dicts";
import { CELL, Cell, Working, type CellState } from "../free/Cell";
import type { Plan, Status, Variant } from "../sim";
import { clamp, ease, lerp, span } from "../time";
import { Ask, TicketCard } from "../Window";
import type { Lang } from "../words";
import { SCENE, type FeatureKey } from "./words";

/** A small scene's own box, in its own pixels; the films place and scale it. */
export const VG = { w: 880, h: 540 };
const clock = (): number => 600;
const plan = (n: number, start: Status, more: Partial<Plan> = {}): Plan => ({ key: `APP-${53 + n}`, agent: n % 2 ? "Codex" : "Claude Code", priority: 2, start, pr: 231 + n, moves: [], written: true, ...more });
/** A piece of the app drawn larger than life, where the scene wants it. */
function Put({ x, y, k = 1, w, children, style }: { x: number; y: number; k?: number; w?: number; children: ReactNode; style?: CSSProperties }) {
  return <div className="vg-put" style={{ left: x, top: y, width: w, transform: `scale(${k})`, ...style }}>{children}</div>;
}
const card = (n: number, variant: Variant, lang: Lang, title?: string) => <TicketCard plan={plan(n, "todo")} words={{ title: title ?? SCENE[lang].tickets[n], label: SCENE[lang].label }} variant={variant} t={0} lang={lang} clock={clock} age={3} />;
const pop = (u: number, at: number): number => ease.back(span(u, at, at + 0.6));

/** Say: a sentence typed into the assistant's composer becomes a ticket, and the ticket five. */
function Say({ u, lang }: { u: number; lang: Lang }) {
  const text = SCENE[lang].idea;
  const typed = [...text].slice(0, Math.ceil(clamp(span(u, 0.2, 2.2)) * [...text].length)).join("");
  const sent = u >= 2.5;
  return (
    <>
      <Put x={30} y={26} k={1.62} w={506}>
        <div className={`ai-composer${sent ? "" : " is-typing"}`}>
          <Icon name="i-plus" size={14} />
          <div className="ai-input film-chat-input">{sent ? <span className="film-chat-hint">{say(lang, "agentPanel.messagePlaceholder")}</span> : <><span>{typed}</span><i className="film-chat-caret" /></>}</div>
          <button type="button" className="btn btn-icon"><Icon name="i-send" size={14} /></button>
        </div>
      </Put>
      {u >= 3 && u < 5 && <Put x={30} y={150} k={1.2 * pop(u, 3)} w={330} style={{ opacity: 1 - span(u, 4.5, 5) }}>{card(-1, "todo", lang, text)}</Put>}
      {[0, 1, 2, 3, 4].map((n) => (u >= 4.5 + n * 0.5 ? <Put key={n} x={30 + (n % 2) * 420} y={150 + Math.floor(n / 2) * 128} k={1.2 * pop(u, 4.5 + n * 0.5)} w={330}>{card(n, "todo", lang)}</Put> : null))}
    </>
  );
}

/** Build: an agent's lines in a terminal pane, and its ticket moving along as each one is written. */
function Build({ u, lang }: { u: number; lang: Lang }) {
  const at = [1, 2.5, 4, 5.5];
  const stage = at.filter((beat) => u >= beat).length;
  const variant: Variant = (["todo", "doing", "doing", "verifying", "done"] as const)[stage];
  const moved = [...at].reverse().find((beat) => u >= beat) ?? -9;
  return (
    <>
      <Put x={26} y={30} k={1.3}>
        <Cell lang={lang} no={1} pane={{ key: "APP-53", agent: "Claude Code", title: "" }} state={stage === 4 ? "done" : "running"} style={{ width: CELL.w, height: 190 }}>
          {SCENE[lang].lines.slice(0, stage).map((line, i) => <div className={`film-term-line${i === 3 ? " is-good" : ""}`} key={line} style={{ backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(30 * (1 - clamp((u - at[i]) / 1.2)))}%, transparent)` }}><b>{i === 3 ? "✓" : "⏺"}</b>{line.startsWith("tomrade") ? <><em>tomrade</em>{line.slice(7)}</> : line}</div>)}
        </Cell>
      </Put>
      <div className="vg-rail" style={{ left: 30, top: 318 }}>{SCENE[lang].rail.map((name, n) => <span key={name} className={n === ["todo", "doing", "verifying", "done"].indexOf(variant) ? "is-here" : undefined}>{name}</span>)}</div>
      <Put x={lerp(30, 30 + ["todo", "doing", "verifying", "done"].indexOf(variant) * 140, 1)} y={384} k={1.25 * (1 + 0.06 * Math.sin(Math.PI * span(u, moved, moved + 0.5)))} w={330} style={{ transition: "none" }}>{card(0, variant, lang)}</Put>
    </>
  );
}

/** Watch: four panes of the Terminal window; one comes to need the person, and is answered. */
function Watch({ u, lang }: { u: number; lang: Lang }) {
  const needs = u >= 3 && u < 5.5;
  const k = 1.17;
  return (
    <>
      {[0, 1, 2, 3].map((i) => {
        const state: CellState | undefined = i === 3 ? undefined : i === 2 && needs ? "needs" : "running";
        const pane = i === 3 ? { key: "", agent: "", title: "zsh · ~/paperplane" } : { key: `APP-${53 + i}`, agent: i % 2 ? "Codex" : "Claude Code", title: "" };
        return (
          <Put key={i} x={14 + (i % 2) * (CELL.w * k + 12)} y={8 + Math.floor(i / 2) * (CELL.h * k + 10)} k={k * (0.9 + 0.1 * pop(u, i * 0.25))} style={{ ["--flash" as string]: i === 2 && u >= 3 ? 1 - span(u, 3, 4) : 0 }}>
            <Cell lang={lang} no={i + 1} pane={pane} state={state} style={{ width: CELL.w, height: CELL.h }}>
              {i === 2 && u >= 3 ? (
                <>
                  <div className="film-term-line"><b>⏺</b>pnpm install</div>
                  <div className="film-term-line is-typed">{SCENE[lang].prompt}{u >= 5.5 ? " y" : ""}</div>
                  {u >= 5.8 && <Working lang={lang} t={u} from={5.8} pace={0.5} shift={2} most={4} />}
                </>
              ) : <Working lang={lang} t={u} from={-3 + i * 0.4} pace={0.55 + i * 0.1} shift={i * 3} shell={i === 3} />}
            </Cell>
          </Put>
        );
      })}
    </>
  );
}

/** Ask: one ticket waits with a question; a choice and a click, and it is at work again. */
function AskScene({ u, lang }: { u: number; lang: Lang }) {
  const answered = u >= 5;
  return (
    <>
      <Put x={30} y={50} k={1.36 * pop(u, 0.2)} w={330}>{card(2, answered ? "doing" : "waiting", lang)}</Put>
      {u >= 1 && <div className="vg-put" style={{ left: 250, top: 230, transform: "scale(1.72)" }}><Ask lang={lang} question={SCENE[lang].question} show={pop(u, 1) * (1 - ease.in(span(u, 5.1, 5.5)))} picked={u >= 3.5} x={0} y={0} /></div>}
      {answered && <b className="vg-stamp" style={{ left: 560, top: 60, transform: `scale(${pop(u, 5)}) rotate(-8deg)` }}>✓</b>}
      {u >= 2.4 && u < 5.6 && <i className="vg-pointer" style={{ left: lerp(700, u >= 4.2 ? 350 : 330, ease.inOut(span(u, 2.4, 3.4))), top: lerp(520, u >= 4.2 ? lerp(402, 468, ease.inOut(span(u, 4.2, 4.9))) : 402, ease.inOut(span(u, 2.4, 3.4))) }} />}
    </>
  );
}

/** Undo: the assistant's reply with its run footer; one click on Revert, and five tickets are one again. */
function Undo({ u, lang }: { u: number; lang: Lang }) {
  const reverted = u >= 4;
  const back = ease.inOut(span(u, 4, 5));
  return (
    <>
      <Put x={30} y={28} k={1.5} w={380}>
        <div className="turn turn-ai">
          <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
          <div className="turn-body">
            <p>{SCENE[lang].reply}</p>
            <div className="run-wrap"><div className="run-foot">
              {reverted ? <span className="rf-note">{say(lang, "agentPanel.revertedPlain")}</span> : <><span className="rf-note">{say(lang, "agentPanel.changedMany", { n: 6 })}</span><button type="button" className="btn btn-ghost rf-btn"><Icon name="i-undo" size={12} /> {say(lang, "agentPanel.revert")}</button></>}
            </div></div>
          </div>
        </div>
      </Put>
      {[0, 1, 2, 3, 4].map((n) => <Put key={n} x={30 + lerp((n % 3) * 284, 0, back)} y={lerp(280 + Math.floor(n / 3) * 122, 290, back)} k={lerp(0.84, n ? 0.84 : 1.3, back)} w={330} style={{ opacity: n ? 1 - back : 1, zIndex: 5 - n }}>{card(n, "todo", lang, n === 0 && back > 0.5 ? SCENE[lang].idea : undefined)}</Put>)}
      {u >= 2.6 && u < 4.8 && <i className="vg-pointer" style={{ left: lerp(760, 316, ease.inOut(span(u, 2.6, 3.7))), top: lerp(500, 196, ease.inOut(span(u, 2.6, 3.7))) }} />}
    </>
  );
}

/** Merge: five tickets and what each waits on; through the night they are merged in order. */
function Night({ u, lang }: { u: number; lang: Lang }) {
  const spot: [number, number][] = [[6, 150], [298, 50], [298, 250], [590, 50], [590, 250]];
  const done = (n: number) => u >= 2 + n;
  const hours = (23 + clamp(span(u, 1, 7)) * 8) % 24;
  const merged = [0, 1, 2, 3, 4].filter(done).length;
  return (
    <>
      <svg className="vg-edges" width={VG.w} height={VG.h} aria-hidden="true">
        {[[0, 1], [0, 2], [1, 3], [2, 4]].map(([a, b]) => <path key={`${a}${b}`} d={`M${spot[a][0] + 288},${spot[a][1] + 50} C${spot[a][0] + 300},${spot[a][1] + 50} ${spot[b][0] - 30},${spot[b][1] + 50} ${spot[b][0] - 2},${spot[b][1] + 50}`} className={done(a) ? "is-done" : undefined} />)}
      </svg>
      {spot.map(([x, y], n) => <Put key={n} x={x} y={y} k={0.87 * (1 + 0.06 * Math.sin(Math.PI * span(u, 2 + n, 2.5 + n)))} w={330} style={{ ["--lit" as string]: done(n) ? 1 - span(u, 2 + n, 3 + n) : 0 }}><div className="film-node is-lit" style={{ position: "static" }}>{card(n, done(n) ? "done" : u >= 1 + n ? "doing" : "todo", lang)}</div></Put>)}
      <div className="vg-clock"><Icon name={hours >= 6 && hours < 12 ? "i-sun" : "i-moon"} size={34} /><span className="num">{String(Math.floor(hours)).padStart(2, "0")}:00</span></div>
      <div className="vg-count num">{SCENE[lang].merged} {merged}/5</div>
    </>
  );
}

const SCENES: Record<FeatureKey, (props: { u: number; lang: Lang }) => ReactNode> = { say: Say, build: Build, watch: Watch, ask: AskScene, undo: Undo, night: Night };

/** One of the six small scenes, u beats into its eight. Each is the app's own pieces, drawn in the theme around it. */
export function Vignette({ id, u, lang, style, className }: { id: FeatureKey; u: number; lang: Lang; style?: CSSProperties; className?: string }) {
  const Scene = SCENES[id];
  return <div className={`vg${className ? ` ${className}` : ""}`} style={{ width: VG.w, height: VG.h, ...style }}><Scene u={u} lang={lang} /></div>;
}
