import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReviewCursor, ReviewPage, ReviewRow, ReviewSaid } from "@tomradex/code-link";
import type { ClosedTerminalRow } from "@tomradex/code-sessions";
import type { MessageKey } from "~/lib/dicts";
import { intlTag, timeAgo } from "~/lib/domain";
import { keys } from "~/lib/queries";
import { alsoKeys, dayLabel, groupByDay, outcomeLine, type OutcomeWords } from "~/lib/review";
import { useErrorToast } from "~/lib/toast";
import { StatusMark } from "./SessionBar";

/** Where the list's pages come from: code link's look back, over the app window's IPC or the Terminal window's bridge. */
export interface ReviewSource {
  /** One page: the newest, the one past `before`, or the newest matches of `query`. */
  list(opts: { before?: ReviewCursor | null; query?: string }): Promise<ReviewPage>;
  /** The ended conversations whose words say `query`, each with the line that says it. */
  said(query: string): Promise<ReviewSaid>;
}

/** The words the list speaks and the language it writes times in: the panel's `useI18n`, or the Terminal window's own. */
export interface ReviewWords {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  locale: string;
}

/**
 * The conversations by day, outcomes first: ended sessions, put-away conversations and idle ones (said so); searched
 * by outcome, ticket and what was said; more on request. On its own, so the Terminal window's session bar holds the
 * same list: there, the plain terminals closed with a recording are a filter of it, each playing back in a cell.
 */
export function ReviewList({ projectId, source, words, agentName, omit, terminals, onPick }: {
  projectId: string;
  source: ReviewSource;
  words: ReviewWords;
  /** An agent's name, by its id. */
  agentName: (agent: string) => string;
  /** The conversations the session bar shows: the list leaves those out. */
  omit?: ReadonlySet<string>;
  /** The Terminal window's closed terminals whose output was recorded, newest first; absent in the app window. */
  terminals?: { rows: ClosedTerminalRow[]; onPick: (t: ClosedTerminalRow) => void };
  onPick: (r: ReviewRow) => void;
}) {
  const { t, locale } = words;
  const say: OutcomeWords = (key, vars) => t(`review.${key}`, vars);
  const tag = intlTag(locale);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const span = (r: { startedAt: number; endedAt: number }) => `${hhmm(r.startedAt)}–${hhmm(r.endedAt)}`;
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query.trim());
  const [filter, setFilter] = useState<"all" | "terminals">("all");
  const closed = filter === "terminals" && !!terminals;
  const first = useQuery({ queryKey: keys.codeLink.review(projectId, ""), queryFn: () => source.list({}) });
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
    source
      .list({ before: next })
      .then((page) => setMore({ after: firstNext, pages: [...pages, page] }), report)
      .finally(() => setReading(false));
  };
  const titles = useQuery({ queryKey: keys.codeLink.review(projectId, typed), queryFn: () => source.list({ query: typed }), enabled: !closed && typed.length > 0 });
  const said = useQuery({ queryKey: keys.review.said(projectId, typed), queryFn: () => source.said(typed), enabled: !closed && typed.length >= 2, staleTime: 5 * 60_000 });
  const rows = useMemo(() => {
    // an idle conversation the bar shows is reached there; the list holds the ones past it
    const shown = (r: ReviewRow) => r.kind === "idle" && !!omit?.has(r.id);
    if (!typed) return [first.data, ...pages].flatMap((p) => p?.rows ?? []).filter((r) => !shown(r));
    const seen = new Set<string>();
    return [...(titles.data?.rows ?? []), ...(said.data?.rows ?? [])].filter((r) => !shown(r) && !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.endedAt - a.endedAt);
  }, [typed, first.data, pages, titles.data, said.data, omit]);
  const saidOnly = (r: ReviewRow) => !!typed && !!said.data?.said[r.id] && !titles.data?.rows.some((x) => x.id === r.id);
  const now = Date.now();
  const day = (d: string) => dayLabel(d, now, { today: t("review.today"), yesterday: t("review.yesterday") }, (at) => new Date(at).toLocaleDateString(tag, { month: "short", day: "numeric" }));
  // The closed terminals are few and already here: the search looks at their titles and folders.
  const needle = typed.toLowerCase();
  const closedRows = closed ? terminals.rows.filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.cwd.toLowerCase().includes(needle)) : [];
  const days = closed ? groupByDay(closedRows) : groupByDay(rows);
  const empty = closed ? !closedRows.length : !rows.length && !first.isLoading && !titles.isFetching && !said.isFetching;
  return (
    <>
      <input type="search" className="input ai-review-search" data-testid="ai-review-search" aria-label={t("review.search")} placeholder={t("review.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
      {terminals && (
        <div className="seg quiet ai-review-filter" role="group" data-testid="cs-history-filter">
          <button type="button" aria-pressed={!closed} data-testid="cs-history-all" onClick={() => setFilter("all")}>
            {t("codeSessions.historyAll")}
          </button>
          <button type="button" aria-pressed={closed} data-testid="cs-history-terminals" onClick={() => setFilter("terminals")}>
            {t("codeSessions.historyTerminals", { n: terminals.rows.length })}
          </button>
        </div>
      )}
      <div className="ai-review-list" data-testid="ai-review-list">
        {days.map((d) => (
          <div key={d.day} className="ai-review-dayset">
            <p className="ai-review-day">{day(d.day)}</p>
            {closed
              ? (d.rows as ClosedTerminalRow[]).map((c) => (
                  <button key={c.id} type="button" className="ai-review-row" data-testid="ai-review-row" data-review={c.id} data-kind="terminal" onClick={() => terminals.onPick(c)}>
                    <span className="ai-review-row-title">
                      <StatusMark status="done" />
                      <span className="mono">{c.title}</span>
                    </span>
                    <span className="meta-txt dense mono">{c.cwd}</span>
                    <span className="meta-txt dense">{[t("codeSessions.closedTerminal"), span(c)].join(" · ")}</span>
                  </button>
                ))
              : (d.rows as ReviewRow[]).map((r) => {
                  const outcome = outcomeLine(r, say);
                  const also = alsoKeys(r);
                  return (
                    <button key={r.id} type="button" className="ai-review-row" data-testid="ai-review-row" data-review={r.id} data-kind={r.kind} onClick={() => onPick(r)}>
                      <span className="ai-review-row-title">
                        <StatusMark status={r.kind === "idle" ? "idle" : "done"} />
                        <span>{r.tickets[0] ? `${r.tickets[0].key} ${r.title}` : r.title || t("agentPanel.newThread")}</span>
                        {r.kind === "idle" && <span className="ai-review-kind">{t("sessionBar.statusIdle")}</span>}
                      </span>
                      {outcome && <span className="ai-review-outcome">{outcome}</span>}
                      <span className="meta-txt dense">{[agentName(r.agent), r.kind === "idle" ? timeAgo(r.endedAt) : span(r), also.length ? t("review.also", { keys: also.join(", ") }) : null].filter(Boolean).join(" · ")}</span>
                      {saidOnly(r) && <span className="ai-review-said" data-testid="ai-review-said">{t("review.said", { text: said.data!.said[r.id]! })}</span>}
                    </button>
                  );
                })}
          </div>
        ))}
        {!closed && typed.length >= 2 && said.isFetching && <p className="meta-txt dense">{t("review.searching")}</p>}
        {empty && <p className="meta-txt dense ai-session-empty">{typed ? t("review.noMatch") : closed ? t("codeSessions.terminalsEmpty") : t("review.empty")}</p>}
        {!closed && !typed && next && (
          <button type="button" className="btn btn-secondary btn-xs ai-review-more" data-testid="ai-review-more" disabled={reading} onClick={readMore}>
            {reading ? t("review.loading") : t("review.more")}
          </button>
        )}
      </div>
    </>
  );
}
