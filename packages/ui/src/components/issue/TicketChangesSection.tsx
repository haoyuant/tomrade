import { useMemo, useState } from "react";
import type { Item } from "@tomradex/domain";
import { ChangesDialog } from "~/components/diff/TicketChanges";
import { Eyebrow } from "~/components/ui/atoms";
import { ticketChanges, useChangeComments, useChangesSummary } from "~/lib/changes";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";

/** What a coding ticket's branch changes, and the way into its diff. Nothing for a ticket with no branch git can show here. */
export function TicketChangesSection({ item, variant = "pane" }: { item: Item; variant?: "pane" | "sheet" }) {
  const { t } = useI18n();
  const toast = useToast();
  const coding = item.kind === "ticket" && item.workType === "coding";
  const summary = useChangesSummary(item.projectId, item.id, coding);
  const [open, setOpen] = useState(false);
  const source = useMemo(() => ticketChanges(item.projectId, item.id), [item.projectId, item.id]);
  const openComments = (useChangeComments(source, coding && !!summary.data).data ?? []).filter((c) => c.state === "open").length;
  if (!coding || !summary.data) return null;
  const { files, additions, deletions } = summary.data;
  const body = (
    <div className="ticket-changes" data-testid="ticket-changes">
      <span className="meta-txt num">{files ? t("diff.summary", { count: files, additions, deletions }) : t("diff.branchUnchanged")}</span>
      {openComments > 0 && <span className="meta-txt num" data-testid="ticket-changes-comments">{t("diff.commentsOnFile", { count: openComments })}</span>}
      <button type="button" className="btn btn-secondary" data-testid="ticket-changes-open" onClick={() => setOpen(true)}>
        {t("diff.open")}
      </button>
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
