import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Icon } from "~/components/icons";
import { PriorityGlyph, StatusMark, Tag } from "~/components/ui/atoms";
import { interpolate, say } from "~/lib/dicts";
import { STATUS, timeAgo } from "~/lib/domain";
import { ANSWERED, COLUMNS, PLAN, RUN, RUN_FROM, VARIANTS, claimedAt, columnsAt, movedAt, place, statusAt, variantAt, type Variant, type paths } from "./sim";
import { COL_W, HEAD_H, TITLEBAR_H, TRACK_PAD, WIN_W, camera, clock, colLeft, folded, type Format } from "./stage";
import { T, clamp, ease, lerp, span } from "./time";
import { CODE_WORDS, PROJECT, QUESTION, TICKETS, type Lang } from "./words";

/** What the cards and a column's head measure, in the window's own pixels. */
export interface Measures { heights: number[][]; head: number }
export type Paths = ReturnType<typeof paths>;

/** How long ago each ticket was last touched when the film opens, in minutes. */
const AGE = [130, 310, 1500, 190, 2900, 380, 1440, 4300, 5800, 22, 200];

/** A ticket's card, in the markup the board's own Card draws (components/workspace/Card.tsx). */
function TicketCard({ n, variant, t, lang }: { n: number; variant: Variant; t: number; lang: Lang }) {
  const plan = PLAN[n];
  const words = TICKETS[lang][n];
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
    <div className="card" data-m={`${n}-${variant}`}>
      {/* an agent's write leaves its tick in the gutter */}
      <span className="card-gutter">{(moved >= 0 || plan.start !== "todo") && <span className="prov-tick" style={{ height: 17 }} />}</span>
      <span className="card-body">
        <span className="card-meta">
          <StatusMark status={variant === "waiting" ? "doing" : variant} />
          <PriorityGlyph priority={plan.priority} />
          <span className="card-id">{plan.key}</span>
          <span className="card-date">{timeAgo((moved >= 0 ? clock(moved) : now - AGE[n]) * 60_000, now * 60_000)}</span>
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
export function Measure({ lang, onDone }: { lang: Lang; onDone: (measures: Measures) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const body = root?.querySelector<HTMLElement>(".col-body");
    if (!root || !body) return;
    const heights = PLAN.map((_, n) => VARIANTS.map((variant) => root.querySelector<HTMLElement>(`[data-m="${n}-${variant}"]`)?.offsetHeight ?? 0));
    onDone({ heights, head: body.offsetTop });
  }, [lang, onDone]);
  return (
    <div className="film-measure sunrise" ref={ref} aria-hidden="true">
      <div className="col">
        <div className="col-head"><span className="col-num">01</span><span className="col-name">{STATUS.todo.label}</span></div>
        <div className="col-body">{PLAN.map((_, n) => VARIANTS.map((variant) => <TicketCard key={`${n}-${variant}`} n={n} variant={variant} t={T.dawn} lang={lang} />))}</div>
      </div>
    </div>
  );
}

/** The middle of a ticket's card in the window's pixels, at t. */
function cardCentre(n: number, t: number, at: Paths, measures: Measures): { x: number; y: number } {
  const spot = place(at[n], t);
  const height = measures.heights[n][VARIANTS.indexOf(variantAt(PLAN[n], t))];
  return { x: colLeft(0) + spot.x + COL_W / 2, y: TITLEBAR_H + HEAD_H + TRACK_PAD + measures.head + spot.y + height / 2 };
}

/**
 * One of the opening's terminals on its way into the board: where its middle is on the frame, its scale against a
 * terminal's own size, its tilt, and how far it has become a card.
 */
export function flight(n: number, t: number, f: Format, at: Paths, measures: Measures) {
  const e = folded(n, t);
  const cam = camera(t, f);
  const [px, py, tilt] = f.pane.at[n];
  const slot = cardCentre(n, t, at, measures);
  return {
    e,
    x: lerp(px, cam.left + slot.x * cam.s, e),
    y: lerp(py, cam.top + slot.y * cam.s, e) - Math.sin(Math.PI * e) * 70,
    scale: lerp(1, (COL_W * cam.s) / f.pane.w, e),
    tilt: lerp(tilt, 0, e),
    card: span(e, 0.32, 0.7)
  };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** The wall clock over the night: the hours go by in seconds. */
function Clock({ t, f }: { t: number; f: Format }) {
  const from = T.night + 0.55;
  if (t < from || t >= T.proof) return null;
  const minutes = Math.round(clock(t)) % 1440;
  const day = minutes > 5 * 60 + 20 && minutes < 12 * 60;
  const wide = f.id === "wide";
  const show = Math.min(ease.outQuint(span(t, from, from + 0.5)), 1 - ease.in(span(t, T.proof - 0.25, T.proof)));
  const style: CSSProperties = wide ? { right: f.w - f.caption.x - f.caption.width, top: f.caption.y + 6, fontSize: f.caption.size * 0.86 } : { left: f.caption.x, top: 462, fontSize: 96 };
  return (
    <div className={`film-clock${day ? " is-day" : ""}`} style={{ ...style, opacity: show, transform: `translate3d(0, ${(1 - show) * 24}px, 0)` }}>
      <Icon name={day ? "i-sun" : "i-moon"} size={Math.round((wide ? f.caption.size : 96) * 0.62)} />
      <span className="num">{two(Math.floor(minutes / 60))}:{two(minutes % 60)}</span>
    </div>
  );
}

/** The question the agent on APP-43 brings, in the assistant's own question block (agent-panel/blocks.tsx). */
function Ask({ t, lang, x, y }: { t: number; lang: Lang; x: number; y: number }) {
  const from = 10.95;
  if (t < from || t > RUN_FROM + 0.5) return null;
  const q = QUESTION[lang];
  const show = ease.back(span(t, from, from + 0.4)) * (1 - ease.in(span(t, ANSWERED + 0.08, ANSWERED + 0.3)));
  const picked = t >= 12.14;
  return (
    <div className="film-ask" style={{ left: x, top: y, opacity: clamp(show * 1.4), transform: `scale(${0.9 + 0.1 * show})` }}>
      <div className="q-ask">
        <span className="q-eyebrow">{say(lang, "agentPanel.waitingPickOne")}</span>
        <p>{q.text}</p>
        <div className="chips">
          {q.options.map((option, i) => (
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

/** The app's window, cut from the real shell: title bar, both panes folded to their rails, the board, the status bar. */
export function BoardScene({ t, f, lang, at, measures }: { t: number; f: Format; lang: Lang; at: Paths; measures: Measures }) {
  if (t < T.turn || t > T.proof + 0.6) return null;
  const cam = camera(t, f);
  const columns = columnsAt(t);
  const going = t >= RUN_FROM;
  const delivered = RUN.filter((n) => statusAt(PLAN[n], t) === "done").length;
  const waiting = PLAN.filter((plan) => variantAt(plan, t) === "waiting").length;
  // The last write, as the status bar's ribbon names it.
  const last = PLAN.flatMap((plan) => plan.moves.map((move) => ({ plan, move }))).filter(({ move }) => move.at <= t).sort((a, b) => b.move.at - a.move.at)[0];
  const leave = ease.in(span(t, T.proof - 0.1, T.proof + 0.5));
  const show = ease.out(span(t, T.turn, T.turn + 0.55)) * (1 - leave);
  const asked = cardCentre(2, Math.max(t, 10.95), at, measures);
  const window: CSSProperties = {
    left: cam.left, top: cam.top + leave * 160, width: WIN_W, height: cam.winH, opacity: show,
    transform: `scale(${cam.s * (1 - 0.04 * leave)})`
  };
  return (
    <>
      <div className="film-window" style={window}>
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
              {going && <span className="num">{delivered}/{RUN.length}</span>}
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
                <Icon name="i-board" size={16} className="view-ico" />
                <h1 className="board-title view-title"><span className="view-name">{say(lang, "tabs.backlog")}</span></h1>
                <span className="board-facts meta-txt">{say(lang, "titleBar.shownOf", { shown: PLAN.length, total: PLAN.length })}</span>
                <span style={{ flex: 1 }} />
                <div className="seg quiet layout-seg" role="group">
                  <button type="button" aria-pressed="true"><Icon name="i-board" size={14} className="ico" /></button>
                  <button type="button" aria-pressed="false"><Icon name="i-bars" size={14} className="ico" /></button>
                  <button type="button" aria-pressed="false"><Icon name="i-graph" size={14} className="ico" /></button>
                </div>
                <button type="button" className="btn btn-ghost"><Icon name="i-sliders" size={14} /><span className="lbl">{say(lang, "titleBar.viewSettings")}</span></button>
              </div>
              <div className="board-scroll-area">
                <div className="col-track film-track">
                  {COLUMNS.map((status, c) => (
                    <section className="col" key={status}>
                      <div className="col-head">
                        <span className="col-num">{two(c + 1)}</span>
                        <span className="col-name">{STATUS[status].label}</span>
                        <span className="col-count num">{columns[status].length}</span>
                      </div>
                      <div className="col-body">
                        {columns[status].length === 0 && <p className="col-empty">{say(lang, "board.emptyPlain", { label: STATUS[status].label })}</p>}
                      </div>
                    </section>
                  ))}
                  {PLAN.map((plan, n) => {
                    const spot = place(at[n], t);
                    const fly = n < f.pane.at.length && t < T.board + 0.6 ? flight(n, t, f, at, measures) : null;
                    const slot = cardCentre(n, t, at, measures);
                    // A card that began as a terminal comes in along the terminal's path, growing out of it.
                    const entry = fly && fly.e < 1
                      ? `translate3d(${(fly.x - cam.left) / cam.s - slot.x}px, ${(fly.y - cam.top) / cam.s - slot.y}px, 0) rotate(${fly.tilt}deg) scale(${(fly.scale * f.pane.w) / (COL_W * cam.s)})`
                      : `translate3d(0, ${-12 * spot.lift}px, 0) scale(${1 + 0.045 * spot.lift})`;
                    return (
                      <div className={`film-card${spot.lift > 0.02 ? " is-lifted" : ""}`} key={plan.key} style={{ left: TRACK_PAD + spot.x, top: TRACK_PAD + measures.head + spot.y, opacity: fly ? fly.card : 1, transform: entry, zIndex: spot.lift > 0.02 || (fly && fly.e < 1) ? 3 : 1 }}>
                        <TicketCard n={n} variant={variantAt(plan, t)} t={t} lang={lang} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="rail ai-rail">
              <button type="button" className="btn btn-icon rail-btn">
                <Icon name="i-panel" size={15} />
                {waiting > 0 && <span className="rail-badge num">{waiting}</span>}
              </button>
              <span className="rail-label">{say(lang, "agentPanel.assistantLabel")}</span>
            </div>
          </div>
          <footer className="statusbar">
            <span className="status-item"><span className="live-dot" />MCP <span className="num">127.0.0.1:19090</span></span>
            {last && (
              <span className="status-item status-ribbon">
                <span className="ribbon-tick" />
                <span className="status-clip">{say(lang, "statusBar.ribbon", { author: last.plan.agent, verb: say(lang, "statusBar.verbUpdated"), key: last.plan.key, time: say(lang, "domain.time_now") })}</span>
              </span>
            )}
            {waiting > 0 && <span className="status-item status-link status-needs"><span className="needs-dot" aria-hidden="true" /> {say(lang, "statusBar.needsYou", { n: waiting })}</span>}
            <button type="button" className="btn btn-ghost status-undo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-undo" size={13} /> {say(lang, "toast.undo")}</button>
            <button type="button" className="btn btn-ghost status-redo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-redo" size={13} /> {say(lang, "toast.redo")}</button>
            <button type="button" className="btn btn-ghost status-history" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }}><Icon name="i-history" size={13} /> {say(lang, "statusBar.history")}</button>
          </footer>
        </div>
        <Ask t={t} lang={lang} x={asked.x + COL_W / 2 + 14} y={asked.y - 46} />
      </div>
      <Clock t={t} f={f} />
    </>
  );
}
