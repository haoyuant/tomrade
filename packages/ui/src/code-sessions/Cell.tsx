import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ClosedTerminalRow, ConversationLine, Layout, SessionRow, TerminalPlace, TerminalRow } from "@tomradex/code-sessions";
import { ConvoLines, ConvoTop, useOpenLines, type ConvoLine } from "~/components/ConversationRead";
import { ContextMenu } from "~/components/ui/menu";
import { onCell, send, type Look } from "./bridge";
import { keyLabel } from "./keys";
import { live, sessionName } from "./lists";
import { Replay } from "./Replay";
import { useSay } from "./say";
import { NewTerminal } from "./NewTerminal";
import { TerminalCell } from "./TerminalCell";

/** The app's lock glyph; open, the shackle lifts off one side. */
const LockGlyph = ({ locked }: { locked: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.15">
      <rect x="3.3" y="6.2" width="7.4" height="5.4" rx="1.2" />
      <path d={locked ? "M5.1 6.2V4.7a1.9 1.9 0 0 1 3.8 0v1.5" : "M5.1 6.2V4.7a1.9 1.9 0 0 1 3.7-.6"} />
    </g>
  </svg>
);

/** Where a session stands; "needs you" wins over its state. */
export function StateChip({ s }: { s: SessionRow }) {
  const say = useSay();
  return (
    <span className="tag cs-chip" data-testid="cs-state" data-state={s.needsYou ? "needs" : s.state}>
      {s.needsYou ? say("needsYou") : say(s.state)}
    </span>
  );
}

/** How herdr reads the agent in a plain terminal, in the session chip's words; blocked is "needs you". */
function AgentChip({ status }: { status: NonNullable<TerminalRow["agentStatus"]> }) {
  const say = useSay();
  const state = status === "working" ? "running" : status === "blocked" ? "needs" : status;
  return (
    <span className="tag cs-chip" data-testid="cs-state" data-state={state}>
      {say(state === "needs" ? "needsYou" : state)}
    </span>
  );
}

type Line = ConvoLine;

/** Lines as the view keeps them, each with a key that stays when earlier ones go in on top. */
const keyed = (lines: ConversationLine[] | null, from: number): Line[] | null => lines?.map((l, i) => ({ ...l, key: from + i })) ?? null;

/** The conversation, or the raw output the pane showed: the two ways an ended session reads back. */
function ReadTabs({ tab, recorded, onPick }: { tab: "convo" | "raw"; recorded: boolean; onPick: (tab: "convo" | "raw") => void }) {
  const say = useSay();
  return (
    <span className="seg cs-read-tabs" role="group" data-testid="cs-read-tabs">
      <button type="button" aria-pressed={tab === "convo"} data-testid="cs-tab-convo" onClick={() => onPick("convo")}>
        {say("convoTab")}
      </button>
      <button type="button" aria-pressed={tab === "raw"} data-testid="cs-tab-raw" data-recorded={recorded || undefined} title={recorded ? undefined : say("rawOnlyWhenShown")} onClick={() => onPick("raw")}>
        {say("rawTab")}
      </button>
    </span>
  );
}

/**
 * An ended session's cell: which agent worked it and when it ended, the way to go on, and its conversation read-only
 * from the agent's own record — or, without one, just the way to go on. It opens at the end; scrolling to the top
 * reads what came before, a stretch at a time. A session that ran in a pane here has a second tab: the raw output
 * the pane showed, played back, where it was recorded.
 */
function Ended({ session, cell, locale, resume, picker, look }: { session: SessionRow; cell: string; locale: string; resume: ReactNode; picker: ReactNode; look: Look }) {
  const say = useSay();
  const [read, setRead] = useState<{ lines: Line[] | null; cut: boolean; start: number | null } | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [open, toggle, closeAll] = useOpenLines();
  const [picking, setPicking] = useState(false);
  const [tab, setTab] = useState<"convo" | "raw">("convo");
  const box = useRef<HTMLDivElement>(null);
  // The view's height before earlier lines went in on top, so what was in view stays there; -1 opens at the end.
  const kept = useRef<number | null>(null);
  useEffect(() => {
    setRead(null);
    setEarlier(false);
    closeAll();
    kept.current = -1;
    const off = onCell(cell, (post) => {
      if (post.type !== "conversation" || post.sessionId !== session.id) return;
      if (post.before === null) {
        kept.current = -1;
        setRead({ lines: keyed(post.lines, 0), cut: post.cut, start: post.start });
        return;
      }
      setEarlier(false);
      kept.current = box.current?.scrollHeight ?? null;
      setRead((now) => {
        if (!now?.lines || now.start !== post.before || !post.lines) return now;
        return { lines: [...keyed(post.lines, (now.lines[0]?.key ?? 0) - post.lines.length)!, ...now.lines], cut: post.cut, start: post.start };
      });
    });
    send({ type: "conversation", cell, sessionId: session.id });
    return off;
  }, [cell, session.id, closeAll]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || kept.current === null) return;
    if (kept.current === -1) {
      el.scrollTop = el.scrollHeight;
      // Lines off screen are laid out at a guessed height until seen; once they are, the end has moved.
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    } else el.scrollTop += el.scrollHeight - kept.current;
    kept.current = null;
  }, [read]);
  const readEarlier = () => {
    if (earlier || !read?.cut || read.start === null) return;
    setEarlier(true);
    send({ type: "conversation", cell, sessionId: session.id, before: read.start });
  };
  const lines = read?.lines?.length ? read.lines : null;
  const when = session.endedAt ? new Date(session.endedAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const who = session.agentName ?? session.agent;
  // Ran in a pane of this window at some point: there may be raw output, and the tab says when there is none.
  const tabs = session.ranIn ? <ReadTabs tab={tab} recorded={session.rawOutput} onPick={setTab} /> : null;
  if (!lines && tab === "convo")
    return (
      <div className="cs-not-here" data-testid="cs-ended">
        <span>{say("endedHere")}</span>
        <span className="cs-row-meta">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {tabs}
        {resume}
        {picker}
      </div>
    );
  return (
    <div className="cs-ended" data-testid="cs-ended">
      <div className="cs-ended-head">
        <span className="cs-row-meta" data-testid="cs-ended-by">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {session.recordSaved && tab === "convo" && (
          <span className="cs-row-meta" data-testid="cs-record-saved">
            {say(session.recordSaved === "end" ? "recordSavedEnd" : "recordSaved")}
          </span>
        )}
        {tabs}
        {resume}
        {picking ? (
          picker
        ) : (
          <button type="button" className="link-btn" data-testid="cs-ended-new" onClick={() => setPicking(true)}>
            {say("orNewTerminal")}
          </button>
        )}
      </div>
      {tab === "raw" ? (
        <Replay cell={cell} id={session.id} font={look.tokens["--font-mono"] ?? ""} tokens={look.tokens} />
      ) : (
        <div className="cs-convo" data-testid="cs-convo" aria-label={say("convoReadOnly")} ref={box} onScroll={(e) => e.currentTarget.scrollTop < 80 && readEarlier()}>
          <ConvoTop cut={!!read?.cut} reading={earlier} onEarlier={readEarlier} say={say} />
          <ConvoLines lines={lines!} open={open} toggle={toggle} say={say} />
        </div>
      )}
    </div>
  );
}

/** A plain terminal closed here: when it ran, and the raw output it showed, played back. */
function ClosedTerminal({ closed, cell, locale, look }: { closed: ClosedTerminalRow; cell: string; locale: string; look: Look }) {
  const say = useSay();
  const at = (t: number) => new Date(t).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="cs-ended" data-testid="cs-closed-terminal">
      <div className="cs-ended-head">
        <span className="cs-row-meta">{say("closedTerminalRan", { from: at(closed.startedAt), to: at(closed.endedAt) })}</span>
      </div>
      <Replay cell={cell} id={closed.id} font={look.tokens["--font-mono"] ?? ""} tokens={look.tokens} />
    </div>
  );
}

function NotHere({ session, cell, locale, picker, onTalk, look }: { session: SessionRow; cell: string; locale: string; picker: ReactNode; onTalk: () => void; look: Look }) {
  const say = useSay();
  const done = session.state === "idle" || session.state === "ended" || session.state === "lost" || session.state === "error";
  // Never while the outside one may still run: two copies would share one conversation. A ticket goes on through code
  // link; a conversation without one, through its agent's own resume.
  const resume =
    done &&
    session.where !== "elsewhere" &&
    (session.itemId ? (
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "continue", sessionId: session.id })}>
        {say("continueNew")}
      </button>
    ) : session.resumable ? (
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-talk-on" onClick={onTalk}>
        {say("talkOn")}
      </button>
    ) : null);
  if (!live(session)) return <Ended session={session} cell={cell} locale={locale} resume={resume} picker={picker} look={look} />;
  if (session.where === "herdr")
    return (
      <div className="cs-not-here" data-testid="cs-ended">
        <span>{say("endedHere")}</span>
        {resume}
        {picker}
      </div>
    );
  if (session.where === "elsewhere") return <div className="cs-not-here">{say("elsewhere")}</div>;
  const terminal = session.terminal ?? say("outsideTerminal");
  return (
    <div className="cs-not-here" data-testid="cs-outside">
      <span>{say("outside", { terminal })}</span>
      <span className="cs-not-here-actions">
        {session.switchable && (
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "switchTo", sessionId: session.id })}>
            {say("switchTo", { terminal })}
          </button>
        )}
        {resume}
      </span>
    </div>
  );
}

export function Cell({ leaf, number, pane, session, terminal, closed, places, ready, herdrClient, onNewTerminal, onTalk, focused, flash = null, selected, only, onFocus, onSplit, onClose, onLock, menu, look }: { leaf: Extract<Layout, { type: "leaf" }>; number: number; pane: string; session: SessionRow | undefined; terminal: TerminalRow | undefined; closed: ClosedTerminalRow | undefined; places: TerminalPlace[]; ready: boolean; herdrClient: boolean; onNewTerminal: (cwd: string) => void; onTalk: (s: SessionRow) => void; focused: boolean; /** Shown here on an ask from outside (the assistant panel, a start): it flashes once, keyed by the ask. */ flash?: number | null; selected: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; onLock: () => void; menu: ReactNode; look: Look }) {
  const say = useSay();
  // Right-click on the bar, or on a cell with no terminal: inside a terminal it is the program's own.
  const withMenu = (node: ReactElement) => (
    <ContextMenu label={say("cellMenu")} trigger={node}>
      {menu}
    </ContextMenu>
  );
  const act = (type: "continue" | "openWorktree" | "openPr" | "focusHerdr" | "openThread") => session && send({ type, sessionId: session.id });
  const labels = useMemo(() => ({ detached: (reason: string | null) => (reason ? say("detached", { reason }) : say("detachedPlain")), reattach: say("reattach"), drop: say("dropFiles") }), [say]);
  return (
    <div className="cs-cell" data-cell={leaf.id} data-focused={focused || undefined} data-flash={flash ?? undefined} data-locked={leaf.locked || undefined} data-cell-terminal={terminal?.id} onMouseDownCapture={onFocus} onFocusCapture={onFocus}>
      {withMenu(<div className="cs-cell-bar">
        {/* Its number in reading order: what `tomrade term --attach` names it by. */}
        <span className="cs-cell-no" data-testid="cs-cell-no" title={say("cellNumber", { n: number })}>{number}</span>
        <span className="cs-cell-name">
          {session?.key ? (
            <>
              <span className="mono">{session.key}</span>{" "}
              {session.agentName && <><span className="cs-cell-agent">{session.agentName}</span>{" "}</>}
              {session.title ?? session.branch}
            </>
          ) : session ? (session.agentTitle ?? sessionName(session)) : terminal ? `${terminal.agentTitle ?? terminal.running ?? terminal.title} · ${terminal.cwd}` : closed ? `${closed.title} · ${closed.cwd}` : say("pick")}
        </span>
        {session ? <StateChip s={session} /> : terminal?.agentStatus ? <AgentChip status={terminal.agentStatus} /> : closed ? <span className="tag cs-chip" data-testid="cs-state" data-state="ended">{say("closedTerminal")}</span> : null}
        {terminal?.note && !session && <span className="cs-cell-note" title={terminal.note}>{terminal.note}</span>}
        {terminal && !session && (
          <span className="cs-cell-actions">
            <button type="button" className="link-btn" onClick={() => send({ type: "closeTerminal", terminalId: terminal.id })}>{say("closeTerminal")}</button>
          </span>
        )}
        {session && (
          <span className="cs-cell-actions">
            {session.mode === "run" ? (
              <button type="button" className="link-btn" onClick={() => act("openThread")}>{say("openThread")}</button>
            ) : session.where === "herdr" ? (
              <>
                <button type="button" className="link-btn" onClick={() => act("continue")}>{say("continue")}</button>
                {herdrClient && (
                  <button type="button" className="link-btn" data-testid="cs-focus-herdr" title={say("focusHerdrHint")} onClick={() => act("focusHerdr")}>
                    {say("focusHerdr")}
                  </button>
                )}
              </>
            ) : null}
            <button type="button" className="link-btn" onClick={() => act("openWorktree")}>{say("openWorktree")}</button>
            <button type="button" className="link-btn" onClick={() => act("openPr")}>{say("openPr")}</button>
          </span>
        )}
        <span className="cs-cell-tools">
          {leaf.sessionId && (
            <button type="button" className="icon-btn cs-lock" data-testid="cs-lock" aria-pressed={!!leaf.locked} title={leaf.locked ? `${say("unlockCell")} · ${say("lockedHint")}` : say("lockCell")} aria-label={leaf.locked ? say("unlockCell") : say("lockCell")} onClick={onLock}>
              <LockGlyph locked={!!leaf.locked} />
            </button>
          )}
          <button type="button" className="icon-btn" title={say("withKey", { action: say("splitRight"), key: keyLabel("splitRight") })} aria-label={say("splitRight")} onClick={() => onSplit("row")}>⇥</button>
          <button type="button" className="icon-btn" title={say("withKey", { action: say("splitDown"), key: keyLabel("splitDown") })} aria-label={say("splitDown")} onClick={() => onSplit("column")}>⤓</button>
          <button type="button" className="icon-btn" title={only ? say("clearCell") : say("withKey", { action: say("closeCell"), key: keyLabel("close") })} aria-label={only ? say("clearCell") : say("closeCell")} onClick={onClose}>×</button>
        </span>
      </div>)}
      {session?.pane || terminal?.pane ? (
        <TerminalCell cell={leaf.id} sessionId={leaf.sessionId!} pane={pane} tokens={look.tokens} font={look.tokens["--font-mono"] ?? ""} labels={labels} autoFocus={selected} />
      ) : terminal ? (
        withMenu(<div className="cs-cell-empty">{say("starting")}</div>)
      ) : session ? (
        withMenu(
          <div className="cs-cell-empty">
            {session.mode === "run" ? say("runMode") : <NotHere session={session} cell={leaf.id} locale={look.locale} picker={<NewTerminal places={places} initial={session.worktree ?? session.cwd} ready={ready} onOpen={onNewTerminal} />} onTalk={() => onTalk(session)} look={look} />}
          </div>
        )
      ) : closed ? (
        withMenu(
          <div className="cs-cell-empty">
            <ClosedTerminal closed={closed} cell={leaf.id} locale={look.locale} look={look} />
          </div>
        )
      ) : (
        withMenu(
          <div className="cs-cell-empty">
            <span>{say("pickOrNew")}</span>
            <NewTerminal places={places} ready={ready} onOpen={onNewTerminal} />
          </div>
        )
      )}
    </div>
  );
}
