import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import { clamp, ease, lerp, span } from "../time";
import type { Lang } from "../words";
import { Dot, Sheet, feature, pop, press, typed } from "./kit";
import { MOMENTS, step } from "./scripts";
import { ARCHIFY_WORDS } from "./words";

const [SENT, PICKED, CHANGED, SAVED] = MOMENTS.archify.clicks;
const [DRAWN, REDRAWN, FILED] = MOMENTS.archify.lands;

/** The diagram's own canvas, in its own pixels, and a node's box on it. */
const CANVAS = { w: 1150, h: 420 };
const BOX = { w: 200, h: 80 };
type NodeId = "web" | "api" | "db" | "pdf" | "mail" | "queue";
/** Archify's palette: a kind of component to a colour, the same on any theme around it. */
const TONE: Record<NodeId, [stroke: string, fill: string]> = {
  web: ["#94a3b8", "#1d3640"], api: ["#22d3ee", "#12414a"], db: ["#a78bfa", "#2e3768"], pdf: ["#34d399", "#14503f"], mail: ["#fbbf24", "#3b4433"], queue: ["#fb7185", "#4a2f3f"]
};
const ORDER: NodeId[] = ["web", "api", "db", "pdf", "mail"];

/**
 * An Archify diagram as its page draws one (packages/archify renders it; the app shows the page in the conversation):
 * components in a boundary, dashed routes that run, a label on each. `born` is the beat it was drawn at, `queue` how
 * far the change that adds the queue has come, `traced` how much of one path is lit.
 */
function Diagram({ lang, q, born, queue = 0, traced = -1, zoom = 1 }: { lang: Lang; q: number; born: number; queue?: number; traced?: number; zoom?: number }) {
  const words = ARCHIFY_WORDS[lang];
  const at: Record<NodeId, [number, number]> = { web: [30, 64], api: [340, 64], db: [650, 64], pdf: [lerp(340, 650, queue), 276], mail: [920, 276], queue: [340, 276] };
  const tracing = traced >= 0;
  /** A route: its ends, its label and where that sits, its tone, and its place on the traced path (none: off it). */
  const routes: { id: string; d: string; label: string; x: number; y: number; tone: NodeId; show: number; on?: number }[] = [
    { id: "order", d: "M230,104 L332,104", label: words.edges.order, x: 268, y: 82, tone: "web", show: pop(q, born + 1.9), on: 0 },
    { id: "write", d: "M540,104 L642,104", label: words.edges.write, x: 595, y: 82, tone: "api", show: pop(q, born + 2.1) },
    { id: "down", d: "M440,144 L440,268", label: queue > 0.5 ? words.edges.push : words.edges.render, x: 440, y: 208, tone: "api", show: pop(q, born + 2.3), on: 1 },
    { id: "pull", d: "M540,316 L642,316", label: words.edges.pull, x: 595, y: 294, tone: "queue", show: clamp((queue - 0.6) * 2.5) },
    { id: "send", d: `M${at.pdf[0] + BOX.w},316 L912,316`, label: words.edges.send, x: (at.pdf[0] + BOX.w + 920) / 2, y: 294, tone: "pdf", show: pop(q, born + 2.5), on: 2 }
  ];
  const lit = (on?: number): number => (!tracing ? 1 : on === undefined ? 0.22 : traced >= on ? 1 : 0.4);
  const node = (id: NodeId, show: number, dim = 1) => {
    const [x, y] = at[id];
    const [stroke, fill] = TONE[id];
    const [name, sub] = words.nodes[id];
    return (
      <g key={id} transform={`translate(${x + BOX.w / 2} ${y + BOX.h / 2}) scale(${show}) translate(${-BOX.w / 2} ${-BOX.h / 2})`} opacity={dim} data-cursor={id === "web" ? "node" : undefined}>
        <rect width={BOX.w} height={BOX.h} rx="10" fill={fill} stroke={stroke} strokeWidth="3" />
        <rect x="12" y="11" width="11" height="11" rx="3" fill="none" stroke={stroke} strokeWidth="1.6" />
        <text x={BOX.w / 2} y="36" textAnchor="middle" className="feat-diagram-name">{name}</text>
        <text x={BOX.w / 2} y="60" textAnchor="middle" className="feat-diagram-sub">{sub}</text>
      </g>
    );
  };
  return (
    <div className="feat-diagram">
      <svg viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} style={{ transform: `scale(${zoom})` }}>
        <defs>
          <pattern id="feat-diagram-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgb(255 255 255 / 0.045)" strokeWidth="1" /></pattern>
        </defs>
        <rect width={CANVAS.w} height={CANVAS.h} fill="url(#feat-diagram-grid)" />
        <g opacity={pop(q, born + 0.2) * (tracing ? 0.5 : 1)}>
          <rect x="300" y="18" width="590" height="384" rx="16" fill="rgb(255 255 255 / 0.025)" stroke="#fbbf24" strokeWidth="1.6" strokeDasharray="9 7" />
          <text x="316" y="42" className="feat-diagram-boundary">{words.boundary}</text>
        </g>
        {routes.map((route) => {
          const stroke = TONE[route.tone][0];
          const shown = clamp(route.show) * lit(route.on);
          if (shown <= 0) return null;
          const hot = tracing && route.on !== undefined && traced >= route.on;
          const width = [...route.label].length * (lang === "zh" ? 16 : 9) + 18;
          const end = route.d.split("L")[1].split(",").map(Number);
          const down = route.id === "down";
          return (
            <g key={route.id} opacity={shown}>
              <path d={route.d} fill="none" stroke={stroke} strokeWidth={hot ? 4.5 : 2.6} strokeDasharray="11 8" strokeDashoffset={-q * 14} />
              <path d={down ? `M${end[0] - 8},${end[1] - 4} L${end[0]},${end[1] + 8} L${end[0] + 8},${end[1] - 4} Z` : `M${end[0] - 4},${end[1] - 8} L${end[0] + 8},${end[1]} L${end[0] - 4},${end[1] + 8} Z`} fill={stroke} />
              <rect x={route.x - width / 2} y={route.y - 12} width={width} height="24" rx="6" fill="#111a33" />
              <text x={route.x} y={route.y + 5} textAnchor="middle" className="feat-diagram-label" fill={stroke}>{route.label}</text>
            </g>
          );
        })}
        {ORDER.map((id, n) => node(id, pop(q, born + 0.5 + n * 0.3), tracing && id === "db" ? 0.3 : 1))}
        {queue > 0 && node("queue", ease.back(clamp(queue * 1.6)))}
      </svg>
    </div>
  );
}

/** The diagram where the conversation shows it (components/workspace/AgentMedia.tsx): the page in its frame, and under it its name and what can be done with it. */
function Figure({ lang, saved, press: pressed = 1, bare = false, children }: { lang: Lang; saved: boolean; press?: number; /** Without what is under it, while the composer is. */ bare?: boolean; children: ReactNode }) {
  return (
    <figure className="feat-figure">
      {children}
      {!bare && <figcaption>
        <span>{ARCHIFY_WORDS[lang].name}</span>
        <a>{say(lang, "agentPanel.downloadMedia")}</a>
        <button type="button" className="btn btn-ghost">{say(lang, "agentPanel.expandMedia")}</button>
        <button type="button" className="btn btn-ghost" disabled={saved} data-cursor="save" style={{ transform: `scale(${pressed})` }}>{say(lang, saved ? "agentPanel.mediaSaved" : "agentPanel.saveMedia")}</button>
      </figcaption>}
    </figure>
  );
}

function Composer({ lang, text }: { lang: Lang; text: string | null }) {
  return (
    <div className={`ai-composer feat-composer${text === null ? "" : " is-typing"}`}>
      <Icon name="i-plus" size={14} />
      <div className="ai-input film-chat-input">{text === null ? <span className="film-chat-hint">{say(lang, "agentPanel.messagePlaceholder")}</span> : <><span>{text}</span><i className="film-chat-caret" /></>}</div>
      <button type="button" className="btn btn-icon" data-cursor="send"><Icon name="i-send" size={14} /></button>
    </div>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = ARCHIFY_WORDS[lang];
  const sheet = { x: 110, y: 214, w: 944, k: 1.8 };
  if (index === 0) {
    const sent = q >= SENT;
    return (
      <>
        <Sheet {...sheet} show={pop(u, 0)} className="feat-chat feat-archify">
          {sent && <div className="turn turn-user"><span className="turn-rule" /><p>{words.ask}</p></div>}
          {q >= SENT + 0.6 && <div className="feat-tool"><Icon name="i-pen" size={12} /><span className="film-mono">diagram_render</span></div>}
          {q >= DRAWN ? <Figure lang={lang} saved={false}><Diagram lang={lang} q={q} born={DRAWN} /></Figure> : <Composer lang={lang} text={sent ? null : typed(words.ask, u, 0.3, 2.1)} />}
        </Sheet>
        <Dot q={q} route={[[SENT - 1.2, [1500, 1040]], [SENT - 0.2, "send"], [SENT + 0.7, "send"]]} click={SENT} />
      </>
    );
  }
  if (index === 1) {
    // lit a route at a time from the node picked, and drawn nearer while it is followed
    const traced = q < PICKED ? -1 : Math.floor((q - PICKED) / 0.8);
    return (
      <>
        <Sheet {...sheet} show={pop(u, 0)} className="feat-archify">
          <div className="feat-head">
            <strong className="feat-title">{words.name}</strong>
            <span className="spacer" />
            <button type="button" className="btn btn-icon"><Icon name="i-close" size={14} /></button>
          </div>
          <Diagram lang={lang} q={q} born={-9} traced={traced} zoom={0.84 + 0.16 * ease.inOut(span(q, PICKED - 0.2, PICKED + 1.8))} />
        </Sheet>
        <Dot q={q} route={[[PICKED - 1.6, [1300, 1040]], [PICKED - 0.2, "node"], [PICKED + 0.9, "node"]]} click={PICKED} />
      </>
    );
  }
  const changed = q >= CHANGED;
  const saved = q >= SAVED;
  return (
    <>
      <Sheet {...sheet} show={1} className="feat-chat feat-archify">
        <div className="turn turn-user"><span className="turn-rule" /><p>{changed ? words.change : words.ask}</p></div>
        <Figure lang={lang} saved={saved} press={press(q, SAVED)} bare={!changed}><Diagram lang={lang} q={q} born={-9} queue={ease.inOut(span(q, REDRAWN, REDRAWN + 1.2))} /></Figure>
        {!changed && <Composer lang={lang} text={typed(words.change, u, 0.3, 2.1)} />}
      </Sheet>
      {/* where it went: the project's Files, the page and the source it was drawn from side by side */}
      <Sheet x={1372} y={336} w={200} k={2.2} show={pop(q, FILED)} className="feat-archify-files">
        <Eyebrow className="side-label side-module-title">{say(lang, "files.eyebrow")}</Eyebrow>
        <div className="side-list side-files-list">
          {[[words.folder, 0, true], [words.name, 1, false], ["diagram.json", 1, false]].map(([name, depth, dir]) => (
            <div className="side-file-row-container" key={String(name)}>
              <button type="button" className={`side-row is-file${dir ? " is-dir" : ""}`} data-depth={depth} style={{ ["--depth" as string]: depth }}>
                {dir ? <span className="ico chev"><Icon name="i-chevdown" size={12} /></span> : <Icon className="ico" name="i-file" size={14} />}
                <span className="side-name">{name}</span>
              </button>
            </div>
          ))}
        </div>
      </Sheet>
      {!changed && <Dot q={q} route={[[CHANGED - 1.2, [1500, 1050]], [CHANGED - 0.2, "send"], [CHANGED + 0.1, "send"]]} click={CHANGED} />}
      {changed && <Dot q={q} route={[[SAVED - 1.4, [1500, 1050]], [SAVED - 0.2, "save"], [SAVED + 0.9, "save"]]} click={SAVED} />}
    </>
  );
}

/** "Still dragging boxes around to draw a diagram? Say it. It draws." */
export const archify = feature({ id: "archify", poster: step(0) + 7.4, words: ARCHIFY_WORDS, Scene });
