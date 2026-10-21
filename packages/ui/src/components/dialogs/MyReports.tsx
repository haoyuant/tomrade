import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReportView } from "@tomradex/doctor";
import { Icon } from "~/components/icons";
import { SectionHead, Spacer, Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useErrorToast } from "~/lib/toast";
import { keys } from "~/lib/queries";
import { REPORT_KIND_KEY } from "./FeedbackDialog";

// The developer's side sets the status, so one this build has no words for shows as itself.
const STATUS_KEY: Record<ReportView["status"], MessageKey> = {
  queued: "about.reportStatus_queued",
  sent: "about.reportStatus_sent",
  new: "about.reportStatus_new",
  triaged: "about.reportStatus_triaged",
  fixed: "about.reportStatus_fixed",
  wontfix: "about.reportStatus_wontfix",
  duplicate: "about.reportStatus_duplicate"
};

/**
 * The troubleshooting reports this person sent: still waiting to go, sent,
 * answered. A reply or a fix shows here, marked new until it has been seen —
 * the bottom bar points here meanwhile. Absent when the troubleshooter is off.
 */
export function MyReports() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const reportError = useErrorToast();
  const reports = useQuery({ queryKey: keys.doctor.reports, queryFn: () => invoke("doctor.reports"), retry: false });
  const unread = reports.data?.unread ?? 0;
  // Seen once shown; the marks stay on screen until the list is read again.
  useEffect(() => {
    if (unread) void invoke("doctor.markRead").catch(() => {});
  }, [unread]);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.doctor.reports });
  const remove = useMutation({ mutationFn: (code: string) => invoke("doctor.deleteReport", code), onSuccess: refresh, onError: reportError });
  const flush = useMutation({ mutationFn: () => invoke("doctor.flush"), onSuccess: refresh, onError: reportError });
  if (!reports.data) return null;
  const { reports: list, signedIn } = reports.data;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  const waiting = list.some((r) => r.status === "queued");

  return (
    <>
      <hr className="rule" />
      <SectionHead
        title={t("about.reportsTitle")}
        aside={waiting && (
          <button type="button" className="btn btn-ghost" disabled={flush.isPending} onClick={() => flush.mutate()}>
            <Icon name="i-sync" size={13} className={flush.isPending ? "is-spinning" : undefined} /> {t("about.reportsSendNow")}
          </button>
        )}
      >
        {t("about.reportsLede")}
      </SectionHead>
      {!signedIn && <p className="meta-txt">{t("about.reportsSignIn")}</p>}
      {list.length === 0 ? (
        <p className="meta-txt">{t("about.reportsEmpty")}</p>
      ) : (
        <div className="panel stack-3 my-reports">
          {list.map((r) => (
            <div className={`my-report${r.unread ? " is-new" : ""}`} key={r.code} data-code={r.code}>
              <div className="row" style={{ gap: 6 }}>
                <span className="num">{r.code}</span>
                <Tag tone={r.status === "fixed" ? "strong" : r.status === "queued" ? "faint" : "neutral"}>{r.status in STATUS_KEY ? t(STATUS_KEY[r.status]) : r.status}</Tag>
                {r.kind && r.kind !== "bug" && <Tag tone="faint">{t(REPORT_KIND_KEY[r.kind])}</Tag>}
                {r.unread && <Tag tone="strong">{t("about.reportNew")}</Tag>}
                <span className="meta-txt">{date(r.createdAt)}</span>
                <Spacer />
                <button type="button" className="btn btn-icon" title={t("about.reportDelete")} aria-label={t("about.reportDelete")}
                  onClick={() => { if (window.confirm(t("about.reportDeleteConfirm", { code: r.code }))) remove.mutate(r.code); }}>
                  <Icon name="i-trash" size={12} />
                </button>
              </div>
              {r.summary && <p className="my-report-summary">{r.summary}</p>}
              {r.reply && (
                <p className="my-report-reply">
                  <strong>{t("about.reportReply")}</strong> {r.reply}
                </p>
              )}
              {r.fixedIn && <p className="meta-txt">{r.fixedHere ? t("about.reportFixedHere", { version: r.fixedIn }) : t("about.reportFixedIn", { version: r.fixedIn })}</p>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
