import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineView } from "@tomradex/agent";
import type { ReviewCursor, ReviewPage, ReviewRow, ReviewView } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { ConvoLines, useOpenLines, type ConvoLine, type ConvoSay } from "~/components/ConversationRead";
import { ReplayPlayer, type RawSay } from "~/components/ReplayPlayer";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { findEngine, useUnarchiveThread } from "~/lib/agent";
import { useStartTicket } from "~/lib/codeLink";
import { workParts } from "~/lib/convoFold";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { alsoKeys, dayLabel, groupByDay, landingSegment, openAtFirst, outcomeLine, segmentKind, segmentSummary, segmentWork, stretchesOf, type OutcomeWords } from "~/lib/review";
import { useErrorToast, useToast } from "~/lib/toast";
import { StatusMark } from "./SessionBar";

/** What the look back opens on: one ended conversation, with the ticket whose stretches alone unfold; null for the list. */
export interface ReviewFocus {
  sessionId?: string;
  threadId?: string;
  itemId?: string;
}

const refOf = (f: ReviewFocus) => (f.sessionId ? `session:${f.sessionId}` : f.threadId ? `thread:${f.threadId}` : "");

/**
 * The look back in the assistant panel: ended conversations by day, what came of each first; one opened read-only,
 * its outcome and tickets on top, the conversation cut by ticket with each stretch marked chat or writing code, and
 * the raw output its pane showed where that was recorded. Counts come with the rows; a record is read only for the
 * conversation opened.
 */
export function Review({ projectId, focus, engines, onClose, onOpenThread }: {
  projectId: string;
  focus: ReviewFocus | null;
  engines: EngineView[] | undefined;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [picked, setPicked] = useState<ReviewFocus | null>(focus);
  // asked for anew (⌘K, a ticket's page): what was open before gives way
  useEffect(() => setPicked(focus), [focus]);
  const say: OutcomeWords = (key, vars) => t(`review.${key}`, vars);
  const agentName = (agent: string) => findEngine(engines, agent)?.title ?? agent;
  const tag = intlTag(locale);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const span = (r: ReviewRow) => `${hhmm(r.startedAt)}–${hhmm(r.endedAt)}`;
  const where = (r: ReviewRow) => t(r.where === "pane" ? "review.whereTerminal" : r.where === "outside" ? "review.whereOutside" : "review.wherePanel");

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
      {picked ? (
        <Opened projectId={projectId} focus={picked} agentName={agentName} span={span} where={where} say={say} onOpenThread={onOpenThread} />
      ) : (
        <List projectId={projectId} agentName={agentName} span={span} say={say} onPick={(r) => setPicked(r.kind === "thread" ? { threadId: r.id } : { sessionId: r.id })} />
      )}
    </div>
  );
}

/** The ended conversations by day, outcomes first; searched by outcome, ticket and what was said; more on request. */
function List({ projectId, agentName, span, say, onPick }: { projectId: string; agentName: (agent: string) => string; span: (r: ReviewRow) => string; say: OutcomeWords; onPick: (r: ReviewRow) => void }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query.trim());
  const first = useQuery({ queryKey: keys.codeLink.review(projectId, ""), queryFn: () => invoke("codeLink.reviewList", projectId) });
  // pages past the first are the person's own doing; the first page moving on (a session ended) starts them over
  const [more, setMore] = useState<{ after: ReviewCursor | null; pages: ReviewPage[] }>({ after: null, pages: [] });
  const [reading, setReading] = useState(false);
  const report = useErrorToast();
  const firstNext = first.data?.next ?? null;
  const pages = useMemo(() => (more.after === firstNext ? more.pages : []), [more, firstNext]);
  const next = (pages.at(-1) ?? first.data)?.next ?? null;
  const readMore = () => {
    if (!next || reading) return;
    setReading(true);
    invoke("codeLink.reviewList", projectId, { before: next })
      .then((page) => setMore({ after: firstNext, pages: [...pages, page] }), report)
      .finally(() => setReading(false));
  };
  const titles = useQuery({ queryKey: keys.codeLink.review(projectId, typed), queryFn: () => invoke("codeLink.reviewList", projectId, { query: typed }), enabled: typed.length > 0 });
  const said = useQuery({ queryKey: keys.review.said(projectId, typed), queryFn: () => invoke("codeLink.reviewSaid", projectId, typed), enabled: typed.length >= 2, staleTime: 5 * 60_000 });
  const rows = useMemo(() => {
    if (!typed) return [first.data, ...pages].flatMap((p) => p?.rows ?? []);
    const seen = new Set<string>();
    return [...(titles.data?.rows ?? []), ...(said.data?.rows ?? [])].filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.endedAt - a.endedAt);
  }, [typed, first.data, pages, titles.data, said.data]);
  const saidOnly = (r: ReviewRow) => !!typed && !!said.data?.said[r.id] && !titles.data?.rows.some((x) => x.id === r.id);
  const now = Date.now();
  const tag = intlTag(locale);
  const day = (d: string) => dayLabel(d, now, { today: t("review.today"), yesterday: t("review.yesterday") }, (at) => new Date(at).toLocaleDateString(tag, { month: "short", day: "numeric" }));
  const days = groupByDay(rows);
  return (
    <>
      <input type="search" className="input ai-review-search" data-testid="ai-review-search" aria-label={t("review.search")} placeholder={t("review.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="ai-review-list" data-testid="ai-review-list">
        {days.map((d) => (
          <div key={d.day} className="ai-review-dayset">
            <p className="ai-review-day">{day(d.day)}</p>
            {d.rows.map((r) => {
              const outcome = outcomeLine(r, say);
              const also = alsoKeys(r);
              return (
                <button key={r.id} type="button" className="ai-review-row" data-testid="ai-review-row" data-review={r.id} onClick={() => onPick(r)}>
                  <span className="ai-review-row-title">
                    <StatusMark status="done" />
                    <span>{r.tickets[0] ? `${r.tickets[0].key} ${r.title}` : r.title || t("agentPanel.newThread")}</span>
                  </span>
                  {outcome && <span className="ai-review-outcome">{outcome}</span>}
                  <span className="meta-txt dense">{[agentName(r.agent), span(r), also.length ? t("review.also", { keys: also.join(", ") }) : null].filter(Boolean).join(" · ")}</span>
                  {saidOnly(r) && <span className="ai-review-said" data-testid="ai-review-said">{t("review.said", { text: said.data!.said[r.id]! })}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {typed.length >= 2 && said.isFetching && <p className="meta-txt dense">{t("review.searching")}</p>}
        {!rows.length && !first.isLoading && !titles.isFetching && !said.isFetching && <p className="meta-txt dense ai-session-empty">{typed ? t("review.noMatch") : t("review.empty")}</p>}
        {!typed && next && (
          <button type="button" className="btn btn-secondary btn-xs ai-review-more" data-testid="ai-review-more" disabled={reading} onClick={readMore}>
            {reading ? t("review.loading") : t("review.more")}
          </button>
        )}
      </div>
    </>
  );
}

/** One conversation opened: the outcome and tickets on top, the ways on, and the conversation by stretch or the raw output. */
function Opened({ projectId, focus, agentName, span, where, say, onOpenThread }: { projectId: string; focus: ReviewFocus; agentName: (agent: string) => string; span: (r: ReviewRow) => string; where: (r: ReviewRow) => string; say: OutcomeWords; onOpenThread: (threadId: string) => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const report = useErrorToast();
  const ref = refOf(focus);
  const view = useQuery({ queryKey: keys.review.open(projectId, ref), queryFn: () => invoke("codeLink.reviewOpen", projectId, { sessionId: focus.sessionId, threadId: focus.threadId }), enabled: !!ref, staleTime: 5 * 60_000 });
  const data = view.data ?? null;
  const [lens, setLens] = useState<"talk" | "raw">("talk");
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
    return (data?.segments ?? []).map((s) => {
      const work = segmentWork(s.lines);
      const lines: ConvoLine[] = s.lines.map((l) => ({ key: key++, who: l.who, text: l.text, ...(l.detail ? { detail: l.detail } : {}) }));
      return { ...s, lines, work, kind: segmentKind(work), summary: segmentSummary(s.lines) };
    });
  }, [data]);
  const wanted = focus.itemId ?? null;
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
  // Going on: a ticket session continues headless in a conversation of its own; a put-away conversation comes back.
  const goOn = () => {
    if (row.kind === "thread") return unarchive.mutate(row.id, { onSuccess: () => onOpenThread(row.id) });
    if (!ticket) return;
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
  const busy = start.isPending || unarchive.isPending;
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
            <span key={tk.itemId} className="ai-review-chip" title={tk.title}>
              {[tk.key, (counts.get(tk.itemId) ?? 0) > 0 ? t((counts.get(tk.itemId) ?? 0) === 1 ? "review.stretch" : "review.stretches", { n: counts.get(tk.itemId) ?? 0 }) : null, tk.pr ? outcomeLine({ pr: tk.pr, commits: 0, asked: null, said: null }, say) : null].filter(Boolean).join(" · ")}
            </span>
          ))}
          {!row.tickets.length && <span className="ai-review-chip">{t("review.noTicket")}</span>}
        </div>
        <div className="ai-review-actions">
          {(ticket || row.kind === "thread") && (
            <button type="button" className="btn btn-primary btn-xs" data-testid="ai-review-resume" title={t(row.kind === "thread" ? "review.resumeThreadHint" : "review.resumeHint")} disabled={busy} onClick={goOn}>
              {t(row.kind === "thread" ? "review.resumeThread" : "review.resume")}
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
        {data.raw && (
          <span className="seg" role="group" data-testid="ai-review-lenses">
            <button type="button" aria-pressed={lens === "talk"} onClick={() => setLens("talk")}>{t("review.lensTalk")}</button>
            <button type="button" aria-pressed={lens === "raw"} data-testid="ai-review-lens-raw" onClick={() => setLens("raw")}>{t("review.lensRaw")}</button>
          </span>
        )}
        <span className="ai-review-lens-note">{t(row.kind === "thread" || row.where === "panel" ? "review.lensNoteThread" : "review.lensNote")}</span>
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
            const isOpen = unfolded.has(i);
            const dim = wanted !== null && s.itemId !== wanted;
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
                    {s.lines.length ? <ConvoLines lines={s.lines} open={open} toggle={toggle} say={convoSay} /> : <p className="meta-txt dense">{t("review.nothingSaid")}</p>}
                    {s.kind === "code" && <span className="ai-review-work">{[t("codeSessions.convoSteps", { n: s.work.steps }), ...workParts(s.work, convoSay)].join(" · ")}</span>}
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
