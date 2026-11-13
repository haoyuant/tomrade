import { useMemo, useState } from "react";
import type { Item } from "@tomradex/domain";
import { ChangesDialog } from "~/components/diff/TicketChanges";
import { Eyebrow } from "~/components/ui/atoms";
import { ReviewStatus } from "~/components/diff/AgentReviewBar";
import { messageOf } from "~/lib/api";
import { ticketChanges, useAgentReviews, useChangeComments, useChangesSummary, useReviewers } from "~/lib/changes";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";

/** What a coding ticket's branch changes, and the way into its diff. Nothing for a ticket with no branch git can show here. */
export function TicketChangesSection({ item, variant = "pane" }: { item: Item; variant?: "pane" | "sheet" }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const coding = item.kind === "ticket" && item.workType === "coding";
  const summary = useChangesSummary(item.projectId, item.id, coding);
  const [open, setOpen] = useState(false);
  const source = useMemo(() => ticketChanges(item.projectId, item.id), [item.projectId, item.id]);
  const openComments = (useChangeComments(source, coding && !!summary.data).data ?? []).filter((c) => c.state === "open").length;
  const shown = coding && !!summary.data;
  const review = useAgentReviews(source, shown).data?.[0];
  const reviewer = useReviewers(source, shown && !!summary.data?.files).data?.pick;
  const [asking, setAsking] = useState(false);
  if (!coding || !summary.data) return null;
  const { files, additions, deletions } = summary.data;
  const when = (at: number) => new Date(at).toLocaleString(intlTag(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const askReview = () => {
    setAsking(true);
    source.startReview().then(
      (started) => toast({ body: t("diff.reviewStarted", { agent: started.engineTitle }) }),
      (error: unknown) => toast({ body: messageOf(error) })
    ).finally(() => setAsking(false));
  };
  const body = (
    <div className="ticket-changes" data-testid="ticket-changes">
      <span className="meta-txt num">{files ? t("diff.summary", { count: files, additions, deletions }) : t("diff.branchUnchanged")}</span>
      {openComments > 0 && <span className="meta-txt num" data-testid="ticket-changes-comments">{t("diff.commentsOnFile", { count: openComments })}</span>}
      <button type="button" className="btn btn-secondary" data-testid="ticket-changes-open" onClick={() => setOpen(true)}>
        {t("diff.open")}
      </button>
      {files > 0 && (
        <button type="button" className="btn btn-ghost" data-testid="ticket-changes-review" disabled={asking || review?.state === "running" || !reviewer} title={reviewer ? t("diff.reviewAskHint") : t("diff.reviewNone")} onClick={askReview}>
          {review ? t("diff.reviewAgain") : t("diff.reviewAsk")}
        </button>
      )}
      {review && (
        <span className="meta-txt ticket-changes__review" data-testid="ticket-changes-review-status">
          <ReviewStatus review={review} when={when} />
        </span>
      )}
      {open && <ChangesDialog open onOpenChange={setOpen} title={t("diff.sheetTitle", { key: item.key })} source={source} viewedKey={item.id} onNotice={(text) => toast({ body: text })} />}
    </div>
  );
  return variant === "pane" ? (
    <section className="detail-sect">
      <Eyebrow>{t("diff.title")}</Eyebrow>
      {body}
    </section>
  ) : (
    <div>
      <hr className="rule" />
      <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("diff.title")}</Eyebrow>
      {body}
    </div>
  );
}
