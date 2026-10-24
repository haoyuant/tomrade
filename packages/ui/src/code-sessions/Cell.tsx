import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { Layout, SessionRow, TerminalPlace, TerminalRow } from "@tomradex/code-sessions";
import { ContextMenu } from "~/components/ui/menu";
import { onCell, send, type Look } from "./bridge";
import { keyLabel } from "./keys";
import { live, sessionName } from "./lists";
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

/** A session whose terminal this window cannot show: where it runs, and what can be done from here. */
type Line = { who: "person" | "agent" | "tool"; text: string };

/**
 * An ended session's cell: which agent worked it and when it ended, the way to go on, and its conversation read-only
 * from the agent's own record — or, without one, just the way to go on.
 */
function Ended({ session, cell, locale, resume, picker }: { session: SessionRow; cell: string; locale: string; resume: ReactNode; picker: ReactNode }) {
  const say = useSay();
  const [read, setRead] = useState<{ lines: Line[] | null; cut: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setRead(null);
    const off = onCell(cell, (post) => {
      if (post.type === "conversation" && post.sessionId === session.id) setRead({ lines: post.lines, cut: post.cut });
    });
    send({ type: "conversation", cell, sessionId: session.id });
    return off;
  }, [cell, session.id]);
  const lines = read?.lines?.length ? read.lines : null;
  const when = session.endedAt ? new Date(session.endedAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const who = session.agentName ?? session.agent;
  if (!lines)
    return (
      <div className="cs-not-here" data-testid="cs-ended">
        <span>{say("endedHere")}</span>
        <span className="cs-row-meta">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {resume}
        {picker}
      </div>
    );
  return (
    <div className="cs-ended" data-testid="cs-ended">
      <div className="cs-ended-head">
        <span className="cs-row-meta" data-testid="cs-ended-by">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {resume}
        {picking ? (
          picker
        ) : (
          <button type="button" className="link-btn" data-testid="cs-ended-new" onClick={() => setPicking(true)}>
            {say("orNewTerminal")}
          </button>
        )}
      </div>
      <div className="cs-convo" data-testid="cs-convo" aria-label={say("convoReadOnly")}>
        {read?.cut && <p className="cs-convo-cut">{say("convoCut")}</p>}
        {lines.map((l, i) => (
          <div key={i} className="cs-convo-line" data-who={l.who}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function NotHere({ session, cell, locale, picker, onTalk }: { session: SessionRow; cell: string; locale: string; picker: ReactNode; onTalk: () => void }) {
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
  if (!live(session)) return <Ended session={session} cell={cell} locale={locale} resume={resume} picker={picker} />;
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

export function Cell({ leaf, pane, session, terminal, places, ready, herdrClient, onNewTerminal, onTalk, focused, selected, only, onFocus, onSplit, onClose, onLock, menu, look }: { leaf: Extract<Layout, { type: "leaf" }>; pane: string; session: SessionRow | undefined; terminal: TerminalRow | undefined; places: TerminalPlace[]; ready: boolean; herdrClient: boolean; onNewTerminal: (cwd: string) => void; onTalk: (s: SessionRow) => void; focused: boolean; selected: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; onLock: () => void; menu: ReactNode; look: Look }) {
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
    <div className="cs-cell" data-cell={leaf.id} data-focused={focused || undefined} data-locked={leaf.locked || undefined} data-cell-terminal={terminal?.id} onMouseDownCapture={onFocus} onFocusCapture={onFocus}>
      {withMenu(<div className="cs-cell-bar">
        <span className="cs-cell-name">
          {session?.key ? (
            <>
              <span className="mono">{session.key}</span>{" "}
              {session.agentName && <><span className="cs-cell-agent">{session.agentName}</span>{" "}</>}
              {session.title ?? session.branch}
            </>
          ) : session ? (session.agentTitle ?? sessionName(session)) : terminal ? `${terminal.agentTitle ?? terminal.running ?? terminal.title} · ${terminal.cwd}` : say("pick")}
        </span>
        {session ? <StateChip s={session} /> : terminal?.agentStatus && <AgentChip status={terminal.agentStatus} />}
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
            {session.mode === "run" ? say("runMode") : <NotHere session={session} cell={leaf.id} locale={look.locale} picker={<NewTerminal places={places} initial={session.worktree ?? session.cwd} ready={ready} onOpen={onNewTerminal} />} onTalk={() => onTalk(session)} />}
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
