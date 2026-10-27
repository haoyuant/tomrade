import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationLine, TimelineEntry, WindowPost } from "@tomradex/code-sessions";
import { ConvoLines, ConvoTop, useOpenLines, type ConvoLine } from "~/components/ConversationRead";
import { onCell, send, type Look } from "./bridge";
import { sessionName } from "./lists";
import { Replay } from "./Replay";
import { useSay } from "./say";

type TimelinePost = Extract<WindowPost, { type: "timeline" }>;

const keyed = (lines: ConversationLine[] | null, from: number): ConvoLine[] | null => lines?.map((l, i) => ({ ...l, key: from + i })) ?? null;

/** A session's conversation, read-only, from the agent's own record; scrolling to the top reads what came before. */
function Convo({ cell, sessionId }: { cell: string; sessionId: string }) {
  const say = useSay();
  const [read, setRead] = useState<{ lines: ConvoLine[] | null; cut: boolean; start: number | null } | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [open, toggle, closeAll] = useOpenLines();
  const box = useRef<HTMLDivElement>(null);
  const kept = useRef<number | null>(null);
  useEffect(() => {
    setRead(null);
    closeAll();
    kept.current = -1;
    const off = onCell(cell, (post) => {
      if (post.type !== "conversation" || post.sessionId !== sessionId) return;
      if (post.before === null) return setRead({ lines: keyed(post.lines, 0), cut: post.cut, start: post.start });
      setEarlier(false);
      kept.current = box.current?.scrollHeight ?? null;
      setRead((now) => (now?.lines && now.start === post.before && post.lines ? { lines: [...keyed(post.lines, (now.lines[0]?.key ?? 0) - post.lines.length)!, ...now.lines], cut: post.cut, start: post.start } : now));
    });
    send({ type: "conversation", cell, sessionId });
    return off;
  }, [cell, sessionId, closeAll]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || kept.current === null) return;
    el.scrollTop = kept.current === -1 ? el.scrollHeight : el.scrollTop + el.scrollHeight - kept.current;
    kept.current = null;
  }, [read]);
  const readEarlier = () => {
    if (earlier || !read?.cut || read.start === null) return;
    setEarlier(true);
    send({ type: "conversation", cell, sessionId, before: read.start });
  };
  if (!read) return <p className="cs-empty">{say("rawLoading")}</p>;
  if (!read.lines?.length) return <p className="cs-empty">{say("timelineNoConvo")}</p>;
  return (
    <div className="cs-convo" aria-label={say("convoReadOnly")} ref={box} onScroll={(e) => e.currentTarget.scrollTop < 80 && readEarlier()}>
      <ConvoTop cut={read.cut} reading={earlier} onEarlier={readEarlier} say={say} />
      <ConvoLines lines={read.lines} open={open} toggle={toggle} say={say} />
    </div>
  );
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * What happened in a pane from early to late, over its cell: the sessions that ran in it and the manual work between
 * them. The one picked reads beside the list — a session as its conversation or its raw output, manual work as raw
 * output only — and the foot says what is kept of each, where, and who can see it.
 */
export function Timeline({ cell, pane, number, cwd, locale, look, onClose }: { cell: string; pane: string; number: number; cwd: string; locale: string; look: Look; onClose: () => void }) {
  const say = useSay();
  const [post, setPost] = useState<TimelinePost | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [lens, setLens] = useState<"convo" | "raw">("convo");
  useEffect(() => {
    setPost(null);
    const off = onCell(cell, (p) => {
      if (p.type === "timeline" && p.pane === pane) setPost(p);
    });
    send({ type: "timeline", cell, pane });
    return off;
  }, [cell, pane]);
  const hour = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const day = (at: number) => new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const entries = post?.entries ?? [];
  const current = entries.find((e) => e.id === picked) ?? entries.at(-1) ?? null;
  const shown = current?.kind === "manual" ? "raw" : lens;
  const title = (e: TimelineEntry) => (e.kind === "manual" ? say("manualWork") : [e.session.key ?? e.session.conversation ?? sessionName(e.session), e.session.agentName ?? e.session.agent].filter(Boolean).join(" · "));
  const meta = (e: TimelineEntry) =>
    e.kind === "manual" ? say("manualMeta", { from: hour(e.from), to: hour(e.to), size: kb(e.bytes) }) : e.to === null ? say(e.session.needsYou ? "needsYou" : "running") : `${hour(e.from)}–${hour(e.to)}${e.session.key && e.session.title ? ` · ${e.session.title}` : ""}`;
  const keep = post?.keep ?? { days: 7, mb: 50 };
  return (
    <div className="cs-pane-timeline" data-testid="cs-pane-timeline">
      <div className="cs-pane-timeline-head">
        <span className="cs-pane-timeline-title mono">{say("timelineHead", { n: number, cwd })}</span>
        <button type="button" className="link-btn" data-testid="cs-timeline-close" onClick={onClose}>
          {say("timelineClose")}
        </button>
      </div>
      {!post ? (
        <p className="cs-empty">{say("timelineLoading")}</p>
      ) : !entries.length ? (
        <p className="cs-empty">{say("timelineEmpty")}</p>
      ) : (
        <div className="cs-pane-timeline-body">
          <ol className="cs-pane-timeline-list" aria-label={say("timelineOpen")}>
            {entries.map((e) => (
              <li key={e.id}>
                <button type="button" className="cs-pane-timeline-row" data-kind={e.kind} data-testid="cs-timeline-entry" aria-current={e.id === current?.id ? "true" : undefined} title={day(e.from)} onClick={() => setPicked(e.id)}>
                  <span className="cs-pane-timeline-at mono">{hour(e.from)}</span>
                  <span className="cs-pane-timeline-what">
                    <span className="cs-pane-timeline-name">{title(e)}</span>
                    <span className="cs-row-meta">{meta(e)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {current && (
            <div className="cs-pane-timeline-read">
              <div className="cs-pane-timeline-read-head">
                <span className="seg cs-read-tabs" role="group">
                  <button type="button" aria-pressed={shown === "convo"} data-testid="cs-timeline-convo" disabled={current.kind === "manual"} title={current.kind === "manual" ? say("manualOnlyRaw") : undefined} onClick={() => setLens("convo")}>
                    {say("convoTab")}
                  </button>
                  <button type="button" aria-pressed={shown === "raw"} data-testid="cs-timeline-raw" onClick={() => setLens("raw")}>
                    {say("rawTab")}
                  </button>
                </span>
              </div>
              {shown === "raw" ? <Replay key={current.id} cell={cell} id={current.id} font={look.tokens["--font-mono"] ?? ""} tokens={look.tokens} /> : <Convo key={current.id} cell={cell} sessionId={current.id} />}
            </div>
          )}
        </div>
      )}
      <details className="cs-layers" data-testid="cs-layers">
        <summary>{say("layersTitle")}</summary>
        <dl>
          {(["Outcome", "Convo", "Raw"] as const).map((layer) => (
            <div key={layer}>
              <dt>{say(`layer${layer}`)}</dt>
              <dd>{say(`layer${layer}What`)}</dd>
              <dd className="cs-row-meta">{say(`layer${layer}Rule`, keep)}</dd>
            </div>
          ))}
        </dl>
        <p className="cs-row-meta">{say("layersNote")}</p>
      </details>
    </div>
  );
}
