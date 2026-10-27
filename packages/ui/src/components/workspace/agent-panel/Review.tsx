import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineView } from "@tomradex/agent";
import type { ReviewRow, ReviewView } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { ConvoLines, useOpenLines, type ConvoLine, type ConvoSay } from "~/components/ConversationRead";
import { ReplayPlayer, type RawSay } from "~/components/ReplayPlayer";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { findEngine, useUnarchiveThread } from "~/lib/agent";
import { useStartTicket } from "~/lib/codeLink";
import { workParts } from "~/lib/convoFold";
import { intlTag, STATUS } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { landingSegment, openAtFirst, outcomeLine, segmentKind, segmentSummary, segmentWork, stretchesOf, type OutcomeWords } from "~/lib/review";
import { markLines, returns, segmentFacts, type MarkWord } from "~/lib/sessionSegments";
import { useErrorToast, useToast } from "~/lib/toast";
import { ReviewList, type ReviewSource } from "./ReviewList";

/** What the look back opens on: one ended conversation, with the ticket whose stretches alone unfold; null for the list. */
export interface ReviewFocus {
  sessionId?: string;
  threadId?: string;
  itemId?: string;
}

const refOf = (f: ReviewFocus) => (f.sessionId ? `session:${f.sessionId}` : f.threadId ? `thread:${f.threadId}` : "");

/** The words every part of the look back shares: an agent's name, a session's span, the outcome's. */
function useReviewWords(engines: EngineView[] | undefined) {
  const { t, locale } = useI18n();
  const say: OutcomeWords = (key, vars) => t(`review.${key}`, vars);
  const agentName = (agent: string) => findEngine(engines, agent)?.title ?? agent;
  const tag = intlTag(locale);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const span = (r: ReviewRow) => `${hhmm(r.startedAt)}–${hhmm(r.endedAt)}`;
  return { say, agentName, span };
}

/**
 * The look back in the assistant panel: ended conversations by day, what came of each first, and the idle ones the
 * session bar no longer shows; one opened read-only, its outcome and tickets on top, the conversation cut by ticket
 * with each stretch marked chat or writing code, and the raw output its pane showed where that was recorded. Counts
 * come with the rows; a record is read only for the conversation opened. An idle conversation opens as itself.
 */
export function Review({ projectId, focus, engines, omit, onClose, onOpenThread }: {
  projectId: string;
  focus: ReviewFocus | null;
  engines: EngineView[] | undefined;
  /** The conversations the session bar shows: the list leaves those out. */
  omit?: ReadonlySet<string>;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const words = useI18n();
  const { t } = words;
  const [picked, setPicked] = useState<ReviewFocus | null>(focus);
  // asked for anew (⌘K, a ticket's page): what was open before gives way
  useEffect(() => setPicked(focus), [focus]);
  const { say, agentName, span } = useReviewWords(engines);
  const where = (r: ReviewRow) => t(r.where === "pane" ? "review.whereTerminal" : r.where === "outside" ? "review.whereOutside" : "review.wherePanel");
  // The list's pages, over the app window's IPC.
  const source = useMemo((): ReviewSource => ({ list: (opts) => invoke("codeLink.reviewList", projectId, opts), said: (query) => invoke("codeLink.reviewSaid", projectId, query) }), [projectId]);

  return (
    <div className="ai-scroll ai-review" data-testid="ai-review">
      <div className="ai-review-head">
        <span className="ai-review-crumb">{t("review.crumb")}</span>
        {picked && (
          <button type="button" className="btn btn-ghost btn-xs" data-testid="ai-review-back" onClick={() => setPicked(null)}>
            <Icon name="i-back" size={11} /> {t("review.back")}
          </button>
        )}
        <button type="button" className="btn btn-icon" title={t("review.close")} aria-label={t("review.close")} onClick={onClose}>
          <Icon name="i-close" size={11} />
        </button>
      </div>
      {!picked && <p className="ai-review-hint meta-txt dense" data-testid="ai-review-hint">{t("review.hint")}</p>}
      {picked ? (
        <Opened projectId={projectId} focus={picked} agentName={agentName} span={span} where={where} say={say} onOpenThread={onOpenThread} />
      ) : (
        <ReviewList projectId={projectId} source={source} words={words} agentName={agentName} omit={omit} onPick={(r) => (r.kind === "idle" ? onOpenThread(r.id) : setPicked(r.kind === "thread" ? { threadId: r.id } : { sessionId: r.id }))} />
      )}
    </div>
  );
}

/** One conversation opened: the outcome and tickets on top, the ways on, and the conversation by stretch or the raw output. */
function Opened({ projectId, focus, agentName, span, where, say, onOpenThread }: { projectId: string; focus: ReviewFocus; agentName: (agent: string) => string; span: (r: ReviewRow) => string; where: (r: ReviewRow) => string; say: OutcomeWords; onOpenThread: (threadId: string) => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const report = useErrorToast();
  const ref = refOf(focus);
  const view = useQuery({ queryKey: keys.review.open(projectId, ref), queryFn: () => invoke("codeLink.reviewOpen", projectId, { sessionId: focus.sessionId, threadId: focus.threadId }), enabled: !!ref, staleTime: Infinity });
  const data = view.data ?? null;
  const [lens, setLens] = useState<"talk" | "raw">("talk");
  const [resuming, setResuming] = useState(false);
  useEffect(() => setLens("talk"), [ref]);
  const raw = useQuery({ queryKey: keys.review.raw(projectId, focus.sessionId ?? ""), queryFn: () => invoke("codeLink.reviewRaw", projectId, focus.sessionId!), enabled: lens === "raw" && !!focus.sessionId && !!data?.raw, staleTime: Infinity });
  const start = useStartTicket(projectId);
  const unarchive = useUnarchiveThread(projectId);
  const convoSay: ConvoSay = (key, vars) => t(`codeSessions.${key}`, vars);
  const rawSay: RawSay = (key, vars) => t(`codeSessions.${key}`, vars);
  const tag = intlTag(locale);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const font = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(), []);

  // The stretches: open as the way in says (all from the list, only the ticket's from its page), landing on the ticket's last.
  const segments = useMemo(() => {
    let key = 0;
    const markSay: MarkWord = (k, vars) => t(`review.${k}`, vars);
    const again = returns(data?.segments ?? []);
    return (data?.segments ?? []).map((s, i) => {
      const work = segmentWork(s.lines);
      const lines: ConvoLine[] = s.lines.map((l) => ({ key: key++, who: l.who, text: l.text, ...(l.detail ? { detail: l.detail } : {}) }));
      return { ...s, lines: markLines(lines, s.key, again[i]!, markSay), work, kind: segmentKind(work), summary: segmentSummary(s.lines) };
    });
  }, [data, t]);
  // A ticket chip picked on top: only its stretches are shown, all of them open, until "Show all".
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => setOnly(null), [ref]);
  const wanted = only ?? focus.itemId ?? null;
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
  const [open, toggle, closeAll] = useOpenLines();
  const landed = useRef<string | null>(null);
  const heads = useRef<Map<number, HTMLElement>>(new Map());
  useEffect(() => {
    if (!data) return;
    setUnfolded(openAtFirst(data.segments, wanted));
    closeAll();
    landed.current = null;
  }, [data, wanted, closeAll]);
  useEffect(() => {
    if (!data || landed.current === ref) return;
    landed.current = ref;
    const at = landingSegment(data.segments, wanted);
    if (at !== null) requestAnimationFrame(() => heads.current.get(at)?.scrollIntoView({ block: "start" }));
  }, [data, ref, wanted]);
  const flip = (i: number) =>
    setUnfolded((now) => {
      const next = new Set(now);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  if (view.isLoading) return <p className="meta-txt dense ai-session-empty">{t("review.loading")}</p>;
  if (!data) return <p className="meta-txt dense ai-session-empty">{t("review.unreadable")}</p>;
  const row = data.row;
  const outcome = outcomeLine(row, say);
  const counts = stretchesOf(data.segments);
  const ticket = row.tickets[0] ?? null;
  // Going on: a ticket session continues headless in a conversation of its own; one on no ticket resumes its own session in
  // the background; a put-away conversation comes back; an idle one opens.
  const goOn = () => {
    if (row.kind === "idle") return onOpenThread(row.id);
    if (row.kind === "thread") return unarchive.mutate(row.id, { onSuccess: () => onOpenThread(row.id) });
    if (!ticket) {
      setResuming(true);
      void invoke("codeLink.resumeSession", projectId, row.id)
        .then((r) => toast({ body: r.ok ? t("review.resumedHere", { agent: agentName(row.agent) }) : r.message }), report)
        .finally(() => setResuming(false));
      return;
    }
    start.mutate({ itemId: ticket.itemId, mode: "run" }, {
      onSuccess: (r) => {
        if (!r.ok) return toast({ body: r.message });
        toast({ body: t("review.went", { key: ticket.key }) });
        if (r.threadId) onOpenThread(r.threadId);
      },
      onError: report
    });
  };
  const goOnInTerminal = () => void invoke("codeLink.resumeInTerminal", projectId, row.id).then((ok) => toast({ body: ok ? t("review.resumed", { agent: agentName(row.agent) }) : t("review.resumeFailed") }), report);
  const busy = start.isPending || unarchive.isPending || resuming;
  return (
    <div className="ai-review-open" data-testid="ai-review-open" data-review={row.id}>
      <div className="ai-review-top">
        <div className="ai-review-headline">
          <span data-testid="ai-review-title">{ticket ? `${ticket.key} ${row.title}` : row.title || t("agentPanel.newThread")}</span>
          <span className="meta-txt dense">{[t("review.readOnly"), agentName(row.agent), where(row), span(row)].join(" · ")}</span>
        </div>
        {(outcome || row.said) && <div className="ai-review-block" data-testid="ai-review-outcome">{outcome ?? row.said}</div>}
        <div className="ai-review-chips" data-testid="ai-review-tickets">
          <span>{t("review.ticketsDone")}</span>
          {row.tickets.map((tk) => (
            <button key={tk.itemId} type="button" className="ai-review-chip" data-testid="ai-review-chip" data-ticket={tk.key} aria-pressed={only === tk.itemId} title={t("review.onlyTicket", { key: tk.key })} disabled={!counts.get(tk.itemId)} onClick={() => setOnly(only === tk.itemId ? null : tk.itemId)}>
              {[tk.key, (counts.get(tk.itemId) ?? 0) > 0 ? t((counts.get(tk.itemId) ?? 0) === 1 ? "review.stretch" : "review.stretches", { n: counts.get(tk.itemId) ?? 0 }) : null, tk.pr ? outcomeLine({ pr: tk.pr, commits: 0, asked: null, said: null }, say) : null].filter(Boolean).join(" · ")}
            </button>
          ))}
          {!row.tickets.length && <span className="ai-review-chip">{t("review.noTicket")}</span>}
          {only && (
            <button type="button" className="link-btn" data-testid="ai-review-all" onClick={() => setOnly(null)}>{t("review.showAll")}</button>
          )}
        </div>
        <div className="ai-review-actions">
          {(ticket || row.kind !== "session" || row.continuable) && (
            <button type="button" className="btn btn-primary btn-xs" data-testid="ai-review-resume" title={t(row.kind === "idle" ? "review.openThreadHint" : row.kind === "thread" ? "review.resumeThreadHint" : ticket ? "review.resumeHint" : "review.resumeSessionHint")} disabled={busy} onClick={goOn}>
              {t(row.kind === "idle" ? "review.openThread" : row.kind === "thread" ? "review.resumeThread" : "review.resume")}
            </button>
          )}
          {row.resumable && (
            <button type="button" className="btn btn-secondary btn-xs" data-testid="ai-review-resume-terminal" title={t("review.resumeTerminalHint")} onClick={goOnInTerminal}>
              {t("review.resumeTerminal")}
            </button>
          )}
        </div>
      </div>
      <div className="ai-review-lens">
        <span className="seg" role="group" data-testid="ai-review-lenses">
          <button type="button" aria-pressed={lens === "talk"} onClick={() => setLens("talk")}>{t("review.lensTalk")}</button>
          {/* not recorded: the raw output stays in sight, greyed, and says why */}
          <button type="button" aria-pressed={lens === "raw"} data-testid="ai-review-lens-raw" disabled={!data.raw} title={data.raw ? undefined : t(row.kind !== "session" || row.where === "panel" ? "review.rawNoneThread" : "review.rawNone")} onClick={() => setLens("raw")}>{t("review.lensRaw")}</button>
        </span>
        {!data.raw && <span className="ai-review-lens-note" data-testid="ai-review-raw-none">{t(row.kind !== "session" || row.where === "panel" ? "review.rawNoneThread" : "review.rawNone")}</span>}
        <span className="ai-review-lens-note">{t(row.kind !== "session" || row.where === "panel" ? "review.lensNoteThread" : "review.lensNote")}</span>
      </div>
      {lens === "raw" ? (
        <div className="ai-review-raw" data-testid="ai-review-raw">
          <p className="ai-review-note">{t("review.rawNote")}</p>
          <ReplayPlayer data={raw.data === undefined ? null : (raw.data ?? { records: [], at: 0, cut: false, clean: false })} font={font} say={rawSay} />
        </div>
      ) : (
        <div className="ai-review-segs" data-testid="ai-review-segments">
          {data.unreadable && <p className="meta-txt dense ai-session-empty">{t("review.unreadable")}</p>}
          {data.cut && <p className="ai-review-note">{t("review.cut")}</p>}
          {segments.map((s, i) => {
            if (only && s.itemId !== only) return null;
            const isOpen = unfolded.has(i);
            const dim = wanted !== null && s.itemId !== wanted;
            const facts = s.itemId ? segmentFacts(row.tickets.find((tk) => tk.itemId === s.itemId), say, (st) => STATUS[st].label) : null;
            return (
              <div key={i} className="ai-review-seg" data-testid="ai-review-seg" data-kind={s.kind} data-ticket={s.key ?? ""} data-open={isOpen || undefined} data-dim={dim || undefined}>
                <button type="button" className="ai-review-seg-head" aria-expanded={isOpen} ref={(el) => { if (el) heads.current.set(i, el); else heads.current.delete(i); }} onClick={() => flip(i)}>
                  <Icon name="i-chev" size={10} style={{ transform: isOpen ? "rotate(90deg)" : undefined, flexShrink: 0 }} />
                  <span className="ai-review-chip">{s.key ?? t(row.tickets.length ? "review.beforeTicket" : "review.noTicket")}</span>
                  <span className="ai-review-kind" data-kind={s.kind}>{t(s.kind === "code" ? "review.kindCode" : "review.kindChat")}</span>
                  <span className="ai-review-seg-title">{s.summary || s.title || ""}</span>
                  {s.from !== null && <span className="ai-review-seg-when">{s.to !== null && s.to !== s.from ? `${hhmm(s.from)}–${hhmm(s.to)}` : hhmm(s.from)}</span>}
                </button>
                {isOpen && (
                  <div className="ai-review-seg-body cs-convo">
                    {s.lines.length ? <ConvoLines lines={s.lines} open={open} toggle={toggle} say={convoSay} coding={s.kind === "code"} /> : <p className="meta-txt dense">{t("review.nothingSaid")}</p>}
                    {s.kind === "code" && <span className="ai-review-work">{[t("codeSessions.convoSteps", { n: s.work.steps }), ...workParts(s.work, convoSay)].join(" · ")}</span>}
                    {facts && <span className="ai-review-work" data-testid="ai-review-seg-facts">{facts}</span>}
                  </div>
                )}
              </div>
            );
          })}
          <Spacer />
        </div>
      )}
    </div>
  );
}
