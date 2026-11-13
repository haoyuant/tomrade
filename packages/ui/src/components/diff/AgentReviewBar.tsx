import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentReviewView } from "@tomradex/change-review";
import { messageOf } from "~/lib/api";
import { useAgentReviews, useReviewers, type ChangesSource } from "~/lib/changes";
import { useI18n } from "~/lib/i18n";

/** What the newest review came to, in a line. */
export function ReviewStatus({ review, when }: { review: AgentReviewView; when: (at: number) => string }) {
  const { t } = useI18n();
  const agent = review.engineTitle;
  const said =
    review.state === "running"
      ? t("diff.reviewRunning", { agent })
      : review.state === "failed"
        ? t("diff.reviewFailed", { agent, why: review.error ?? "" })
        : review.state === "cancelled"
          ? t("diff.reviewCancelled", { agent })
          : review.findings
            ? t("diff.reviewFound", { agent, count: review.findings, when: when(review.endedAt ?? review.startedAt) })
            : t("diff.reviewClean", { agent, when: when(review.endedAt ?? review.startedAt) });
  return (
    <>
      <span data-testid="changes-review-status" data-state={review.state}>{said}</span>
      {review.stale && review.state !== "running" && (
        <span className="tag faint" title={t("diff.reviewStaleHint")} data-testid="changes-review-stale">
          {t("diff.reviewStale")}
        </span>
      )}
      {review.roleTitle && review.role !== "reviewer" && <span className="tag faint" data-testid="changes-review-role">{review.roleTitle}</span>}
      {review.askedBy === "auto" && <span className="tag faint">{t("diff.reviewAuto")}</span>}
      {review.handedAt !== null && <span className="tag faint">{t("diff.reviewHanded")}</span>}
    </>
  );
}

/**
 * An agent's review of the changes above the diff: what the newest one came to, and the way to ask for one, with the
 * agent that will read. One that also wrote the change is said to have.
 */
export function AgentReviewBar({ source, when, onNotice }: { source: ChangesSource; when: (at: number) => string; onNotice: (text: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const reviews = useAgentReviews(source).data ?? [];
  const [askedRole, setAskedRole] = useState<string>();
  const choices = useReviewers(source, true, askedRole).data;
  const [asked, setAsked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const newest = reviews[0];
  const running = newest?.state === "running";
  const engines = choices?.engines ?? [];
  const chosen = engines.find((engine) => engine.id === asked && engine.ok)?.id ?? choices?.pick ?? undefined;
  const chosenTitle = engines.find((engine) => engine.id === chosen)?.title ?? "";
  const same = !!chosen && chosen === choices?.author;
  const again = () => void qc.invalidateQueries({ queryKey: source.commentsKey });
  const start = async () => {
    if (busy || running || !chosen) return;
    setBusy(true);
    try {
      const review = await source.startReview({ engine: chosen, role: choices?.role ?? undefined });
      onNotice(t("diff.reviewStarted", { agent: review.engineTitle }));
    } catch (error) {
      onNotice(messageOf(error));
    } finally {
      setBusy(false);
      again();
    }
  };
  const release = () => void source.releaseReview().then(again, again);
  return (
    <div className="diff__review" data-testid="changes-review">
      <span className="diff__review-status">
        {newest ? <ReviewStatus review={newest} when={when} /> : <span className="meta-txt">{t("diff.reviewAskHint")}</span>}
        {newest?.held && (
          <>
            <span className="tag" data-testid="changes-review-held">{t("diff.reviewHeld")}</span>
            <button type="button" className="btn btn-ghost btn-xs" data-testid="changes-review-release" onClick={release}>
              {t("diff.reviewRelease")}
            </button>
          </>
        )}
        {same && !running && <span className="meta-txt" data-testid="changes-review-same">{t("diff.reviewSame", { agent: chosenTitle })}</span>}
      </span>
      <span className="diff__review-actions">
        {(choices?.roles.length ?? 0) > 1 && (
          <select className="input diff__pick" aria-label={t("diff.reviewRoleLabel")} data-testid="changes-review-role-pick" value={choices?.role ?? ""} disabled={busy || running} onChange={(e) => { setAskedRole(e.target.value); setAsked(undefined); }}>
            {choices!.roles.map((role) => (
              <option key={role.id} value={role.id}>{role.title}</option>
            ))}
          </select>
        )}
        {engines.length > 1 && (
          <select className="input diff__pick" aria-label={t("diff.reviewerLabel")} data-testid="changes-reviewer" value={chosen ?? ""} disabled={busy || running} onChange={(e) => setAsked(e.target.value)}>
            {engines.map((engine) => (
              <option key={engine.id} value={engine.id} disabled={!engine.ok}>
                {engine.ok ? engine.title : t("diff.reviewerOff", { agent: engine.title, why: engine.why ?? "" })}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-secondary" data-testid="changes-review-start" disabled={busy || running || !chosen} title={chosen ? t("diff.reviewAskHint") : t("diff.reviewNone")} onClick={() => void start()}>
          {newest ? t("diff.reviewAgain") : t("diff.reviewAsk")}
        </button>
      </span>
    </div>
  );
}
