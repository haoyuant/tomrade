import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Icon } from "~/components/icons";
import { PriorityGlyph, StatusMark, Tag } from "~/components/ui/atoms";
import { interpolate, say } from "~/lib/dicts";
import { STATUS, timeAgo } from "~/lib/domain";
import { COLUMNS, VARIANTS, claimedAt, movedAt, paths, type Plan, type Status, type Stop, type Variant } from "./sim";
import type { Format } from "./stage";
import { CODE_WORDS, PROJECT, type Lang, type TicketWords } from "./words";

/** What the cards and a column's head measure, in the window's own pixels, and where that puts every card through the story. */
export interface Measures { heights: number[][]; head: number }
export type Paths = Stop[][];
export interface Board { measures: Measures; at: Paths }

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * A ticket's card, in the markup the board's own Card draws (components/workspace/Card.tsx). `clock` is the film's
 * wall clock, in minutes, and `age` how long before the film the ticket was last touched.
 */
export function TicketCard({ m, plan, words, variant, t, lang, clock, age }: {
  /** Names the card for the pass that measures it. */ m?: string; plan: Plan; words: TicketWords; variant: Variant; t: number; lang: Lang; clock: (t: number) => number; age: number;
}) {
  const code = CODE_WORDS[lang];
  const now = clock(t);
  const moved = movedAt(plan, t);
  const minutes = Math.max(1, Math.round(now - clock(claimedAt(plan))));
  const session = variant !== "doing" ? null : interpolate(code.session, {
    agent: plan.agent,
    where: code.pane,
    time: minutes < 60 ? interpolate(code.minutes, { n: minutes }) : interpolate(code.hours, { n: Math.round(minutes / 60) })
  });
  return (
    <div className="card" data-m={m}>
      {/* an agent's write leaves its tick in the gutter */}
      <span className="card-gutter">{(moved >= 0 || plan.start !== "todo" || plan.written) && <span className="prov-tick" style={{ height: 17 }} />}</span>
      <span className="card-body">
        <span className="card-meta">
          <StatusMark status={variant === "waiting" ? "doing" : variant} />
          <PriorityGlyph priority={plan.priority} />
          <span className="card-id">{plan.key}</span>
          <span className="card-date">{timeAgo((moved >= 0 ? clock(moved) : now - age) * 60_000, now * 60_000)}</span>
        </span>
        <span className="card-title">{words.title}</span>
        {session && (
          <span className="card-session">
            <span className="card-session-mark" aria-hidden="true" />
            <span className="card-session-label">{session}</span>
          </span>
        )}
        <span className="card-foot">
          <Tag tone="neutral">{words.label}</Tag>
          {variant === "waiting" && <Tag tone="strong">{code.waiting}</Tag>}
          {variant === "verifying" ? <Tag tone="strong">PR #{plan.pr}</Tag> : variant === "done" ? <Tag tone="faint">{code.merged}</Tag> : variant !== "todo" ? <Tag tone="neutral">{code.branch}</Tag> : null}
        </span>
      </span>
    </div>
  );
}

/** Every card in every state it takes, laid out once out of sight, so the simulation knows their heights. */
export function Measure({ plans, words, lang, clock, age, t, onDone }: { plans: Plan[]; words: TicketWords[]; lang: Lang; clock: (t: number) => number; age: number[]; /** The moment the cards are measured at. */ t: number; onDone: (board: Board) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const body = root?.querySelector<HTMLElement>(".col-body");
    if (!root || !body) return;
    const heights = plans.map((_, n) => VARIANTS.map((variant) => root.querySelector<HTMLElement>(`[data-m="${n}-${variant}"]`)?.offsetHeight ?? 0));
    onDone({ measures: { heights, head: body.offsetTop }, at: paths(plans, (n, variant) => heights[n][VARIANTS.indexOf(variant)]) });
  }, [plans, words, lang, onDone]);
  return (
    <div className="film-measure sunrise" ref={ref} aria-hidden="true">
      <div className="col">
        <div className="col-head"><span className="col-num">01</span><span className="col-name">{STATUS.todo.label}</span></div>
        <div className="col-body">{plans.map((plan, n) => VARIANTS.map((variant) => <TicketCard key={`${n}-${variant}`} m={`${n}-${variant}`} plan={plan} words={words[n]} variant={variant} t={t} lang={lang} clock={clock} age={age[n]} />))}</div>
      </div>
    </div>
  );
}

/** A question an agent brings, in the assistant's own question block (agent-panel/blocks.tsx), beside its ticket. */
export function Ask({ lang, question, show, picked, x, y }: { lang: Lang; question: { text: string; options: readonly [string, string] }; /** How far it has come up: 0 away, 1 there. */ show: number; picked: boolean; x: number; y: number }) {
  return (
    <div className="film-ask" style={{ left: x, top: y, opacity: Math.min(1, Math.max(0, show * 1.4)), transform: `scale(${0.9 + 0.1 * show})` }}>
      <div className="q-ask">
        <span className="q-eyebrow">{say(lang, "agentPanel.waitingPickOne")}</span>
        <p>{question.text}</p>
        <div className="chips">
          {question.options.map((option, i) => (
            <button key={option} type="button" className={picked && i === 0 ? "chip-opt sel" : "chip-opt"} data-cursor={i === 0 ? "chip" : undefined}>{option}</button>
          ))}
        </div>
        <div className="q-confirm">
          <button type="button" className="btn btn-primary" data-cursor="confirm">{say(lang, "agentPanel.confirm")}</button>
        </div>
      </div>
    </div>
  );
}

/** The wall clock over the night: the hours go by in seconds. `minutes` since midnight; `show` 0 away, 1 there. */
export function WallClock({ minutes, show, f }: { minutes: number; show: number; f: Format }) {
  const now = Math.round(minutes) % 1440;
  const day = now > 5 * 60 + 20 && now < 12 * 60;
  const wide = f.id === "wide";
  const style: CSSProperties = wide ? { right: f.w - f.caption.x - f.caption.width, top: f.caption.y + 6, fontSize: f.caption.size * 0.86 } : { left: f.caption.x, top: 462, fontSize: 96 };
  return (
    <div className={`film-clock${day ? " is-day" : ""}`} style={{ ...style, opacity: show, transform: `translate3d(0, ${(1 - show) * 24}px, 0)` }}>
      <Icon name={day ? "i-sun" : "i-moon"} size={Math.round((wide ? f.caption.size : 96) * 0.62)} />
      <span className="num">{two(Math.floor(now / 60))}:{two(now % 60)}</span>
    </div>
  );
}

/** The board's four columns, empty: the cards are laid over them, each where the story has it. */
export function ColumnHeads({ columns, lang }: { columns: Record<Status, number[]>; lang: Lang }) {
  return (
    <>
      {COLUMNS.map((status, c) => (
        <section className="col" key={status}>
          <div className="col-head">
            <span className="col-num">{two(c + 1)}</span>
            <span className="col-name">{STATUS[status].label}</span>
            <span className="col-count num">{columns[status].length}</span>
          </div>
          <div className="col-body" data-cursor={`col-${status}`}>
            {columns[status].length === 0 && <p className="col-empty">{say(lang, "board.emptyPlain", { label: STATUS[status].label })}</p>}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * The app's window, cut from the real shell: the title bar, the sidebar folded to its rail, a view's head over what
 * the film puts in it, the assistant (open, or folded to its rail) and the status bar.
 */
export function AppWindow({ lang, style, shown, layout = "board", going, waiting, ribbon, assistant, children, over }: {
  lang: Lang; style: CSSProperties; /** How many tickets the view shows. */ shown: number; layout?: "board" | "graph";
  /** The auto run, once it is going: how many it has delivered of how many. */ going?: { done: number; total: number } | null;
  /** How many agents wait for the person. */ waiting: number;
  /** The last write, as the status bar names it. */ ribbon?: { author: string; verb: "Created" | "Updated" | "Deleted"; key: string } | null;
  /** The assistant's open panel; its rail when there is none. */ assistant?: ReactNode;
  children: ReactNode; /** Drawn over the app, in the window's own pixels. */ over?: ReactNode;
}) {
  return (
    <div className="film-window" style={style}>
      <div className="app">
        <header className="titlebar">
          <span className="film-lights" aria-hidden="true"><i /><i /><i /></span>
          <button type="button" className="btn btn-icon"><Icon name="i-home" size={16} /></button>
          <span className="title-sep" />
          <button type="button" className="btn btn-ghost film-project" style={{ padding: "4px 8px" }}>
            <Icon name="i-stack" size={15} className="ico" /><span>{PROJECT[lang]}</span><Icon name="i-chevdown" size={13} className="chev" />
          </button>
          <span className="crumb-sep">/</span>
          <span className="crumb-title">{say(lang, "tabs.backlog")}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost"><Icon name="i-search" size={14} /><span>{say(lang, "titleBar.search")}</span><span className="kbd">⌘K</span></button>
          <button type="button" className="btn btn-primary"><Icon name="i-plus" size={14} />{say(lang, "titleBar.newButton")}</button>
          <button type="button" className={`btn btn-ghost titlebar-night-shift${going ? " is-going" : ""}`} data-cursor="autorun">
            <Icon name="i-moon" size={15} />
            <span className="lbl">{say(lang, "nightShift.title")}</span>
            {going && <span className="num">{going.done}/{going.total}</span>}
          </button>
          <button type="button" className="btn btn-ghost titlebar-terminal"><Icon name="i-terminal" size={15} /><span className="lbl">{say(lang, "titleBar.terminalWindow")}</span></button>
          <button type="button" className="btn btn-icon"><Icon name="i-bars" size={17} /></button>
          <button type="button" className="btn btn-icon"><Icon name="i-gear" size={17} /></button>
        </header>
        <div className="workspace side-railed">
          <div className="rail side-rail">
            <button type="button" className="btn btn-icon rail-btn"><Icon name="i-panel" size={15} /></button>
            <span className="rail-label">{say(lang, "sidebar.projectRailLabel")}</span>
          </div>
          <div className="main-col film-main">
            <div className="board-head view-head">
              <Icon name={layout === "graph" ? "i-graph" : "i-board"} size={16} className="view-ico" />
              <h1 className="board-title view-title"><span className="view-name">{say(lang, "tabs.backlog")}</span></h1>
              <span className="board-facts meta-txt">{say(lang, "titleBar.shownOf", { shown, total: shown })}</span>
              <span style={{ flex: 1 }} />
              <div className="seg quiet layout-seg" role="group">
                <button type="button" aria-pressed={layout === "board"}><Icon name="i-board" size={14} className="ico" /></button>
                <button type="button" aria-pressed="false"><Icon name="i-bars" size={14} className="ico" /></button>
                <button type="button" aria-pressed={layout === "graph"} data-cursor="graph"><Icon name="i-graph" size={14} className="ico" /></button>
              </div>
              <button type="button" className="btn btn-ghost"><Icon name="i-sliders" size={14} /><span className="lbl">{say(lang, "titleBar.viewSettings")}</span></button>
            </div>
            {children}
          </div>
          {assistant ?? (
            <div className="rail ai-rail">
              <button type="button" className="btn btn-icon rail-btn">
                <Icon name="i-panel" size={15} />
                {waiting > 0 && <span className="rail-badge num">{waiting}</span>}
              </button>
              <span className="rail-label">{say(lang, "agentPanel.assistantLabel")}</span>
            </div>
          )}
        </div>
        <footer className="statusbar">
          <span className="status-item"><span className="live-dot" />MCP <span className="num">127.0.0.1:19090</span></span>
          {ribbon && (
            <span className="status-item status-ribbon">
              <span className="ribbon-tick" />
              <span className="status-clip">{say(lang, "statusBar.ribbon", { author: ribbon.author, verb: say(lang, `statusBar.verb${ribbon.verb}`), key: ribbon.key, time: say(lang, "domain.time_now") })}</span>
            </span>
          )}
          {waiting > 0 && <span className="status-item status-link status-needs"><span className="needs-dot" aria-hidden="true" /> {say(lang, "statusBar.needsYou", { n: waiting })}</span>}
          <button type="button" className="btn btn-ghost status-undo" data-cursor="undo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-undo" size={13} /> {say(lang, "toast.undo")}</button>
          <button type="button" className="btn btn-ghost status-redo" data-cursor="redo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-redo" size={13} /> {say(lang, "toast.redo")}</button>
          <button type="button" className="btn btn-ghost status-history" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-history" size={13} /> {say(lang, "statusBar.history")}</button>
        </footer>
      </div>
      {over}
    </div>
  );
}
