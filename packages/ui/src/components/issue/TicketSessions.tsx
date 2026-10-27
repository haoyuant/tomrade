import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TimelineEntry, TimelineStop } from "@tomradex/code-link";
import { Eyebrow, FoldChevron, FoldChevronSpace } from "~/components/ui/atoms";
import { Icon } from "~/components/icons";
import { findEngine, useEngines } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { offerApart, useTicketTimeline } from "~/lib/codeLink";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { openExternal } from "~/lib/shell";

/**
 * The ticket's sessions by when each began, each saying first what came of it; one taken up again (a resume, a move
 * between the panel and a cell) is one row, unfolded to where it went. Above them, what the ticket delivered, and a
 * warning when two work in one folder at once.
 */
export function TicketSessions({ projectId, itemId, variant = "pane" }: { projectId: string; itemId: string; variant?: "pane" | "sheet" }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const timeline = useTicketTimeline(projectId, itemId);
  const engines = useEngines();
  const [open, setOpen] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: (sessionId: string) => invoke("codeLink.stopSession", projectId, sessionId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) })
  });
  const data = timeline.data;
  if (!data?.entries.length) return null;
  const tag = intlTag(locale);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const day = (at: number) => new Date(at).toLocaleDateString(tag, { month: "short", day: "numeric" });
  const when = (e: TimelineEntry) => {
    const started = new Date(e.startedAt).toDateString() === new Date().toDateString() ? hhmm(e.startedAt) : `${day(e.startedAt)} ${hhmm(e.startedAt)}`;
    return e.endedAt === null ? t("codeLink.timelineSince", { time: started }) : `${started}–${hhmm(e.endedAt)}`;
  };
  const place = (s: TimelineStop) => (s.where === "terminal" && s.terminal ? s.terminal.replace(/\.app$/, "") : t(`codeLink.timelinePlace_${s.where}`));
  // the places in a row, each change of place once: assistant → terminal cell → assistant
  const route = (e: TimelineEntry) => e.stops.map(place).filter((p, i, all) => i === 0 || all[i - 1] !== p).join(" → ");
  const facts = (e: TimelineEntry) =>
    [e.commits ? t("codeLink.timelineCommits", { n: e.commits }) : null, e.continued ? t("codeLink.timelineContinued", { n: e.continued }) : null, e.asked ? t("codeLink.timelineAsked", { n: e.asked }) : null, e.live ? t("codeLink.timelineRunning") : null].filter(Boolean).join(" · ");
  const { delivered, clash } = data;
  const pr = delivered.pr && delivered.pr.number !== null ? t(`codeLink.deliveredPr_${delivered.pr.state ?? "open"}`, { n: delivered.pr.number }) : null;
  const clashCount = clash ? data.entries.filter((e) => e.live && e.folder === clash.folder).length : 0;
  const stopLater = (then?: () => void) =>
    clash &&
    stop.mutate(clash.laterSession, {
      onSuccess: () => (then ? then() : toast({ body: t("codeLink.clashStopped") })),
      onError: (error) => toast(errorSpec(error))
    });

  const body = (
    <div className="ticket-sessions" data-testid="ticket-sessions">
      {clash && (
        <div className="start-problem ticket-clash" role="alert" data-testid="ticket-clash">
          <p className="start-problem-lead">{t("codeLink.clashTitle", { n: clashCount })}</p>
          <p className="meta-txt num">{t("codeLink.clashBody", { folder: clash.folder, branch: clash.branch })}</p>
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" data-testid="ticket-clash-move" disabled={stop.isPending} onClick={() => stopLater(() => offerApart(itemId))}>
              {t("codeLink.clashMove")}
            </button>
            <button type="button" className="btn btn-secondary" data-testid="ticket-clash-stop" disabled={stop.isPending} onClick={() => stopLater()}>
              {t("codeLink.clashStop")}
            </button>
          </div>
        </div>
      )}
      <p className="meta-txt ticket-delivered" data-testid="ticket-delivered">
        <span>{t("codeLink.deliveredHead")}</span>{" "}
        {pr && delivered.pr?.url ? (
          <a href={delivered.pr.url} onClick={(e) => { e.preventDefault(); openExternal(delivered.pr!.url!); }}>{pr}</a>
        ) : pr}
        {pr && " · "}
        {t("codeLink.deliveredCommits", { n: delivered.commits, sessions: delivered.sessions })}
        {delivered.files !== null && ` · ${t("codeLink.deliveredFiles", { n: delivered.files })}`}
      </p>
      <ul className="ticket-timeline" data-testid="ticket-timeline">
        {data.entries.map((e) => {
          const unfolded = open === e.id;
          return (
            <li key={e.id} className="ticket-timeline-row" data-live={e.live || undefined} data-testid="ticket-timeline-row">
              {e.stops.length > 1 ? <FoldChevron open={unfolded} label={t("codeLink.timelineFold")} onToggle={() => setOpen(unfolded ? null : e.id)} /> : <FoldChevronSpace />}
              <div className="ticket-timeline-body">
                <span className="meta-txt dense">
                  {e.live && <span className="card-session-mark" aria-hidden="true" />} {[findEngine(engines.data, e.agent)?.title ?? e.agent, when(e), route(e)].join(" · ")}
                </span>
                <span className="ticket-timeline-outcome">{e.outcome ?? t("codeLink.timelineNoOutcome")}</span>
                {facts(e) && <span className="meta-txt dense">{facts(e)}</span>}
                {unfolded && (
                  <div className="ticket-timeline-stops" data-testid="ticket-timeline-stops">
                    <span className="eyebrow">{t("codeLink.timelineStops")}</span>
                    <ol>
                      {e.stops.map((s) => (
                        <li key={s.sessionId} className="meta-txt dense">
                          <Icon name={s.where === "panel" ? "i-panel" : "i-terminal"} size={11} /> {hhmm(s.at)} · {place(s)}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return variant === "pane" ? (
    <section className="detail-sect">
      <Eyebrow>{t("codeLink.timelineHead")}</Eyebrow>
      {body}
    </section>
  ) : (
    <div>
      <hr className="rule" />
      <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("codeLink.timelineHead")}</Eyebrow>
      {body}
    </div>
  );
}
