import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineView } from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";
import { PROMPT_LINES, promptOnScreen } from "@tomradex/code-link/prompt";
import { Icon } from "~/components/icons";
import { ConvoLines, ConvoTop, useOpenLines, type ConvoSay } from "~/components/ConversationRead";
import { Spacer } from "~/components/ui/atoms";
import { invoke, subscribe } from "~/lib/api";
import { findEngine } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { isCommitKey, isComposing } from "~/lib/keys";
import { ATTENTION_KEY } from "~/lib/attention";
import type { BarStatus } from "~/lib/sessionBar";
import { convoFromTail, convoLines, convoRefreshed, convoWithEarlier, delayUntil, DRAWER_ROWS, askText, isApprovalAsk, isLive, mayReadPane, saidElsewhere, STRIP_ROWS, tailLines, type ConvoState } from "~/lib/terminalSession";
import { useErrorToast, useToast } from "~/lib/toast";
import { StatusMark } from "./SessionBar";

/** How long Allow or Deny stays answered on its own before the session's next event says what came of it. */
const ANSWERED_MS = 8000;

/**
 * A coding session running in a terminal, seen from the assistant panel: the same session as the Terminal window's
 * cell, from another side. Its conversation comes from the agent's own record, re-read a page at a time as the
 * session moves; a strip above it shows the pane's last lines, opening into a drawer with more; what is typed below
 * goes into the pane as keystrokes. Nothing here attaches to the pane, so the Terminal window keeps its control.
 */
export function TerminalSession({ projectId, session, title, ticket, status, engines, cell, onShowInTerminal, onBack, backBlocked, onClose, onAnswered }: {
  projectId: string;
  session: SessionView;
  title: string;
  ticket: string | null;
  status: BarStatus;
  engines: EngineView[] | undefined;
  /** The Terminal window cell that shows it, by the window's number; null when none does. */
  cell: number | null;
  /** Present when the Terminal window can be asked to show it. */
  onShowInTerminal?: () => void;
  /** Present for a conversation's own session: brings the conversation back to the panel once its CLI exited. */
  onBack?: () => void;
  /** Why it cannot come back yet: its CLI still runs here. */
  backBlocked?: string;
  onClose: () => void;
  /** Allow or Deny went through: the panel may move on to what else waits. */
  onAnswered?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const reportError = useErrorToast();
  const live = isLive(session);
  const agentName = findEngine(engines, session.agent)?.title ?? session.agent;
  const where = cell ? t("sessionBar.whereCell", { n: cell }) : session.herdrPane ? t("sessionBar.wherePane") : session.terminal ? session.terminal.replace(/\.app$/, "") : t("sessionBar.whereOutside");
  const say: ConvoSay = (key, vars) => t(`codeSessions.${key}`, vars);

  // What this machine lets the panel do with the pane: asked once per session, not on every change of it.
  const panel = useQuery({
    queryKey: ["sessionPanel", projectId, session.id, session.agent, session.herdrPane, live],
    queryFn: () => invoke("codeLink.sessionPanel", projectId, session.id),
    staleTime: Infinity
  });
  const canType = panel.data?.input === "ok";

  // ── the conversation, from the agent's record ──────────────────────────
  const [convo, setConvo] = useState<ConvoState | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [open, toggle, closeAll] = useOpenLines();
  const box = useRef<HTMLDivElement>(null);
  /** Whether the view follows new lines: true until the person scrolls up to read, again once they come back down. */
  const following = useRef(true);
  /** The view's height before earlier lines went in on top, so what was in view stays there; -1 opens at the end. */
  const kept = useRef<number | null>(-1);
  /** When the last read of the tail started, and the one pending: reads are at least a second apart per session. */
  const readAt = useRef<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The session's last movement, and the one the view last read for: a change schedules one read, a re-render none. */
  const move = `${session.lastEventAt}|${session.state}|${session.activity}|${session.ask?.kind}`;
  const latestMove = useRef(move);
  latestMove.current = move;
  const seen = useRef("");
  const generation = useRef(0);
  /** What this view typed into the pane, and since when it shows the session: a person's line after that it did not type was said in the terminal. */
  const sentHere = useRef(new Set<string>());
  const shownSince = useRef(Date.now());

  const readTail = useCallback(async (first: boolean) => {
    const mine = ++generation.current;
    readAt.current = Date.now();
    const read = await invoke("codeLink.conversation", projectId, session.id).catch(() => null);
    if (mine !== generation.current) return;
    kept.current = first || following.current ? -1 : null;
    setConvo((now) => (first || !now ? convoFromTail(read) : convoRefreshed(now, read)));
  }, [projectId, session.id]);

  useEffect(() => {
    setConvo(null);
    setReadingEarlier(false);
    closeAll();
    following.current = true;
    readAt.current = null;
    sentHere.current = new Set();
    shownSince.current = Date.now();
    seen.current = latestMove.current;
    if (session.externalId) void readTail(true);
    else { generation.current++; setConvo(convoFromTail(null)); }
    return () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [projectId, session.id, session.externalId, closeAll, readTail]);

  // The session moved (a hook spoke, herdr read its screen): the tail is read again, at most once a second.
  useEffect(() => {
    if (move === seen.current || !session.externalId) return;
    seen.current = move;
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void readTail(false);
    }, delayUntil(readAt.current, Date.now()));
  }, [move, session.externalId, readTail]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || kept.current === null) return;
    if (kept.current === -1) {
      el.scrollTop = el.scrollHeight;
      // Lines off screen are laid out at a guessed height until seen; once they are, the end has moved.
      requestAnimationFrame(() => { if (following.current) el.scrollTop = el.scrollHeight; });
    } else el.scrollTop += el.scrollHeight - kept.current;
    kept.current = null;
  }, [convo]);

  const readEarlier = () => {
    if (readingEarlier || !convo || convo.before === null) return;
    const before = convo.before;
    setReadingEarlier(true);
    void invoke("codeLink.conversation", projectId, session.id, before)
      .then((read) => {
        kept.current = box.current?.scrollHeight ?? null;
        setConvo((now) => (now ? convoWithEarlier(now, before, read) : now));
      }, reportError)
      .finally(() => setReadingEarlier(false));
  };

  // ── the pane's screen: a strip of its last lines, a drawer with more ──────
  const [drawer, setDrawer] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const look = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", look);
    const off = subscribe("window.wake", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      off();
    };
  }, []);
  const reads = mayReadPane({ shown: true, visible, pane: !!session.herdrPane, live });
  const tailAt = useRef<number | null>(null);
  useEffect(() => {
    if (!reads) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // an agent that declared its approval keys: enough of the screen to see whether a prompt is on it
    const rows = drawer ? DRAWER_ROWS : panel.data?.approval ? Math.max(STRIP_ROWS, PROMPT_LINES) : STRIP_ROWS;
    const tick = async () => {
      tailAt.current = Date.now();
      const text = await invoke("codeLink.sessionTail", projectId, session.id, rows).catch(() => null);
      if (stopped) return;
      setScreen(text);
      timer = setTimeout(tick, delayUntil(tailAt.current, Date.now()));
    };
    timer = setTimeout(tick, delayUntil(tailAt.current, Date.now()));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [reads, drawer, projectId, session.id, panel.data?.approval]);
  const strip = tailLines(screen, 2);

  // ── what is typed goes into the pane; Allow and Deny press the agent's own keys ──
  const [draft, setDraft] = useState("");
  const [drawerDraft, setDrawerDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** The event of the ask showing now, and the asks answered from here, by their events. */
  const askedAt = useRef<number | null | undefined>(undefined);
  const answeredHere = useRef(new Set<number | null>());
  const sayToPane = async (said: string, clear: () => void) => {
    const text = said.trim();
    if (!text || !canType || sending) return;
    setSending(true);
    try {
      if (await invoke("codeLink.sessionSay", projectId, session.id, text)) {
        sentHere.current.add(text);
        clear();
      } else toast({ body: t("sessionBar.notTaken") });
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  };
  const answer = async (which: "allow" | "deny") => {
    if (sending) return;
    setSending(true);
    try {
      const result = await invoke("codeLink.sessionAnswer", projectId, session.id, which);
      if (result === "answered") {
        // answered here: the prompt stays gone until the session's next event says where it stands
        setAnswered(session.lastEventAt);
        answeredHere.current.add(session.lastEventAt);
        setTimeout(() => setAnswered(null), ANSWERED_MS);
        onAnswered?.();
      } else if (result === "notPrompt") {
        // nothing was pressed: what its screen asks is answered in the pane
        toast({ body: t("sessionBar.answerInPane"), actions: onShowInTerminal ? [{ label: t("sessionBar.showInTerminal"), run: onShowInTerminal }] : undefined });
      } else toast({ body: t("sessionBar.notTaken") });
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  };
  const asking = isApprovalAsk(session) && answered !== session.lastEventAt;
  // Answered on the other side (its cell, or the terminal): the ask goes down here too, with a line saying where.
  const [answeredThere, setElsewhere] = useState<{ id: string; text: string } | null>(null);
  const elsewhere = answeredThere?.id === session.id ? answeredThere.text : null;
  const asks = isApprovalAsk(session);
  useEffect(() => {
    if (asks) {
      askedAt.current = session.lastEventAt;
      return;
    }
    const was = askedAt.current;
    askedAt.current = undefined;
    if (was === undefined || answeredHere.current.has(was) || !live) return;
    const ran = session.state === "running";
    setElsewhere({ id: session.id, text: cell ? t(ran ? "sessionBar.allowedInCell" : "sessionBar.answeredInCell", { n: cell }) : t(ran ? "sessionBar.allowedInTerminal" : "sessionBar.answeredInTerminal") });
    const timer = setTimeout(() => setElsewhere(null), ANSWERED_MS);
    return () => clearTimeout(timer);
  }, [asks, live, session.id, session.lastEventAt, session.state, cell, t]);
  // The drawer closes on Esc, wherever in the panel the keyboard is.
  const drawerBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isComposing(e) || !drawerBox.current?.closest(".ai")?.contains(e.target as Node)) return;
      e.preventDefault();
      setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);
  // Allow and Deny only while the screen shows a prompt they answer: Allow with yes under the cursor, Deny with either.
  const onScreen = useMemo(() => promptOnScreen(screen ?? ""), [screen]);
  const inputNote = !live ? t("sessionBar.inputEnded") : panel.data?.input === "noPane" ? t("sessionBar.inputOutside", { app: where }) : panel.data?.input === "noBackend" ? t("sessionBar.inputNoBackend") : panel.data?.input === "unsupported" ? t("sessionBar.inputUnsupported") : null;
  const lines = useMemo(() => (convo ? convoLines(convo) : []), [convo]);
  // what the person said in the terminal while this view showed it, marked where it came from
  const notes = useMemo(() => {
    const note = cell ? t("sessionBar.saidInCell", { n: cell }) : t("sessionBar.saidInTerminal");
    return new Map(saidElsewhere(lines, shownSince.current, sentHere.current).map((key) => [key, note]));
  }, [lines, cell, t]);
  const asked = session.ask ? askText(session.ask, t) : null;
  const wait = status === "wait" ? asked ?? session.activity ?? session.summary ?? t(ATTENTION_KEY[session.state === "error" ? "stuck" : "waiting"]) : null;

  return (
    <>
      <div className="ai-scroll ai-session" data-testid="ai-session" data-session={session.id} data-state={session.state}>
        <div className="ai-session-head">
          <StatusMark status={status} />
          <span className="ai-session-title" title={title}>
            {ticket && <span className="mono">{ticket} </span>}
            {title || t("agentPanel.newThread")}
          </span>
          <Spacer />
          {session.herdrPane && live ? (
            // the same pane, seen here and, once a cell shows it, in the Terminal window too
            <div className="seg ai-session-views" role="group" aria-label={t("sessionBar.viewsLabel")} data-testid="ai-session-views">
              <button type="button" aria-pressed="true" data-testid="ai-session-here">{t("sessionBar.viewHere")}</button>
              <button type="button" aria-pressed={!!cell} data-testid="ai-session-show" disabled={!onShowInTerminal} title={cell ? t("sessionBar.showInTerminalCell", { n: cell }) : t("sessionBar.showInTerminal")} onClick={onShowInTerminal}>
                <Icon name="i-terminal" size={12} />
                {t("sessionBar.viewTerminal")}
              </button>
            </div>
          ) : (
            onShowInTerminal && (
              <button type="button" className="btn btn-ghost ai-session-show" data-testid="ai-session-show" onClick={onShowInTerminal}>
                <Icon name="i-terminal" size={12} />
                {cell ? t("sessionBar.showInTerminalCell", { n: cell }) : t("sessionBar.showInTerminal")}
              </button>
            )
          )}
          {onBack && (
            <button type="button" className="btn btn-ghost ai-session-show" data-testid="back-to-panel" disabled={!!backBlocked} title={backBlocked ?? t("handoff.backTitle")} onClick={onBack}>
              <Icon name="i-back" size={12} />
              {t("handoff.back")}
            </button>
          )}
          <button type="button" className="btn btn-icon" title={t("sessionBar.backToThreads")} aria-label={t("sessionBar.backToThreads")} onClick={onClose}>
            <Icon name="i-close" size={11} />
          </button>
        </div>
        <p className="ai-session-meta meta-txt dense">
          {[agentName, where, t(status === "wait" ? "sessionBar.statusWait" : status === "run" ? "sessionBar.statusRun" : status === "done" ? "sessionBar.statusDone" : "sessionBar.statusIdle")].join(" · ")}
          {wait && <span className="ai-session-wait"> · {wait}</span>}
          {cell && live && <span data-testid="ai-session-both"> · {t("sessionBar.bothOpen", { n: cell })}</span>}
        </p>
        {session.herdrPane && live && (
          <button type="button" className="ai-strip" data-testid="ai-strip" aria-expanded={drawer} aria-label={t(drawer ? "sessionBar.paneOutputLess" : "sessionBar.paneOutputMore")} title={t(drawer ? "sessionBar.paneOutputLess" : "sessionBar.paneOutputMore")} onClick={() => setDrawer((d) => !d)}>
            <span className="ai-strip-lines">
              <span className="ai-strip-title" data-testid="ai-strip-title">{cell ? t("sessionBar.stripTitleCell", { n: cell }) : t("sessionBar.stripTitle")}</span>
              {strip.length ? strip.map((line, i) => <span key={i} className="ai-strip-line">{line}</span>) : <span className="ai-strip-line is-quiet">{t("sessionBar.paneQuiet")}</span>}
            </span>
            <Icon name="i-chevdown" size={10} className="ai-strip-chev" style={drawer ? { transform: "rotate(180deg)" } : undefined} />
          </button>
        )}
        <div
          className="ai-session-convo cs-convo"
          data-testid="ai-session-convo"
          aria-label={t("sessionBar.conversation")}
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            if (el.scrollTop < 80) readEarlier();
          }}
        >
          {convo?.unreadable ? (
            <p className="meta-txt dense ai-session-empty">{t("sessionBar.noConversation")}</p>
          ) : convo ? (
            <>
              <ConvoTop cut={convo.before !== null} reading={readingEarlier} onEarlier={readEarlier} say={say} />
              <ConvoLines lines={lines} open={open} toggle={toggle} say={say} waiting={asking} notes={notes} />
            </>
          ) : null}
        </div>
      </div>
      <div className="ai-foot ai-session-foot">
        {drawer && session.herdrPane && live && (
          <div className="ai-drawer-box" ref={drawerBox} data-testid="ai-drawer-box">
            <div className="ai-drawer-head">
              <span className="ai-drawer-title" data-testid="ai-drawer-title">{[title || t("agentPanel.newThread"), cell ? t("sessionBar.whereCell", { n: cell }) : null, canType ? t("sessionBar.drawerTypes") : null].filter(Boolean).join(" · ")}</span>
              <button type="button" className="btn btn-ghost btn-xs" data-testid="ai-drawer-close" onClick={() => setDrawer(false)}>{t("sessionBar.drawerClose")}</button>
            </div>
            <pre className="ai-drawer" data-testid="ai-drawer" aria-label={t("sessionBar.paneOutput")}>{screen ?? ""}</pre>
            {canType && (
              <label className="ai-drawer-input">
                <span aria-hidden="true">&gt;</span>
                <input
                  data-testid="ai-drawer-input"
                  placeholder={t("sessionBar.drawerInput")}
                  aria-label={t("sessionBar.sayAria")}
                  value={drawerDraft}
                  disabled={sending}
                  autoFocus
                  onChange={(e) => setDrawerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (isComposing(e) || e.key !== "Enter") return;
                    e.preventDefault();
                    void sayToPane(drawerDraft, () => setDrawerDraft(""));
                  }}
                />
              </label>
            )}
          </div>
        )}
        {elsewhere && <p className="ai-answered-there meta-txt dense" data-testid="ai-answered-there" role="status">{elsewhere}</p>}
        {asking && (
          <div className="ai-approve" data-testid="ai-approve" role="group" aria-label={asked ?? t("agentPanel.attention_permission")}>
            <span className="ai-approve-text">{asked ?? t("agentPanel.attention_permission")}</span>
            {panel.data?.approval && canType && onScreen ? (
              <>
                {onScreen.allows && <button type="button" className="btn btn-primary btn-xs" data-testid="ai-allow" disabled={sending} onClick={() => void answer("allow")}>{t("sessionBar.allow")}</button>}
                <button type="button" className="btn btn-secondary btn-xs" data-testid="ai-deny" disabled={sending} onClick={() => void answer("deny")}>{t("sessionBar.deny")}</button>
              </>
            ) : onShowInTerminal ? (
              <button type="button" className="btn btn-secondary btn-xs" data-testid="ai-answer-there" title={panel.data && !panel.data.approval ? t("sessionBar.answerNoKeys", { agent: agentName }) : panel.data?.approval ? t("sessionBar.answerInPane") : undefined} onClick={onShowInTerminal}>{t("sessionBar.answerInTerminal")}</button>
            ) : null}
          </div>
        )}
        {inputNote ? (
          <p className="ai-workdir meta-txt dense" data-testid="ai-session-note">{inputNote}</p>
        ) : (
          <div className="ai-composer" data-busy={sending || undefined}>
            <textarea
              ref={input}
              className="ai-input"
              rows={1}
              placeholder={cell ? t("sessionBar.sayHereCell", { agent: agentName, n: cell }) : t("sessionBar.sayHere", { agent: agentName })}
              aria-label={t("sessionBar.sayAria")}
              disabled={!canType}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isComposing(e) || !isCommitKey(e) || e.shiftKey) return;
                e.preventDefault();
                void sayToPane(draft, () => setDraft(""));
              }}
            />
            <button type="button" className="btn btn-icon ai-send" title={t("sessionBar.send")} aria-label={t("sessionBar.send")} disabled={!canType || !draft.trim() || sending} onClick={() => void sayToPane(draft, () => setDraft(""))}>
              <Icon name="i-send" size={14} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
