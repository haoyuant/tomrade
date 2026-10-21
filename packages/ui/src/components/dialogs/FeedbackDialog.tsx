import { useDeferredValue, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReportKind } from "@tomradex/doctor";
import { Dialog, DialogBody, DialogFoot, DialogHead, useOpeningKey } from "~/components/ui/dialog";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { readableError } from "~/lib/toast";
import { keys } from "~/lib/queries";

const KINDS: ReportKind[] = ["bug", "feedback", "idea"];
export const REPORT_KIND_KEY: Record<ReportKind, MessageKey> = { bug: "feedback.kind_bug", feedback: "feedback.kind_feedback", idea: "feedback.kind_idea" };
const PLACEHOLDER_KEY: Record<ReportKind, MessageKey> = { bug: "feedback.placeholder_bug", feedback: "feedback.placeholder_feedback", idea: "feedback.placeholder_idea" };

/**
 * Writing in to Tomrade's developer without anything having failed: a bug, a
 * piece of feedback, an idea. It goes the way a troubleshooting report goes —
 * kept on this machine until it is sent, answered under My reports — and
 * carries nothing but what was written and the app's version and system.
 * Each opening starts clean.
 */
export function FeedbackDialog(props: Parameters<typeof FeedbackSheet>[0]) {
  return <FeedbackSheet key={useOpeningKey(props.open)} {...props} />;
}

function FeedbackSheet({ open, onOpenChange, onTroubleshoot }: { open: boolean; onOpenChange: (open: boolean) => void; onTroubleshoot: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ReportKind>("feedback");
  const [text, setText] = useState("");
  const typed = useDeferredValue(text.trim());
  const send = useMutation({ mutationFn: () => invoke("doctor.sendFeedback", kind, text) });
  // what goes besides the text, read from the report as it would be sent
  const preview = useQuery({ queryKey: keys.doctor.feedbackPreview(kind, typed), queryFn: () => invoke("doctor.feedbackPreview", kind, typed), enabled: open && !!typed, placeholderData: (previous) => previous });
  const app = preview.data?.app;
  const result = send.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("feedback.title")} className="sheet-report">
      <DialogHead title={t("feedback.title")} />
      <DialogBody className="stack-3">
        {result ? (
          <div className="stack-2 report-result" role="status">
            <p className="dlg-sub">
              <Icon name={result.state === "sent" ? "i-check" : "i-clock"} size={14} /> {result.state === "sent" ? t("feedback.sent", { code: result.code }) : t("feedback.queued", { code: result.code })}
            </p>
            <p className="meta-txt">{result.state === "sent" ? t("feedback.sentNext") : t("feedback.queuedWhy", { reason: result.reason ?? "" })}</p>
          </div>
        ) : (
          <>
            <p className="meta-txt">{t("feedback.lede")}</p>
            <div className="seg quiet" role="radiogroup" aria-label={t("feedback.kindAria")} data-testid="feedback-kind">
              {KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {t(REPORT_KIND_KEY[k])}
                </button>
              ))}
            </div>
            {kind === "bug" && (
              <p className="meta-txt">
                {t("feedback.bugHint")}{" "}
                <button type="button" className="link-inline" onClick={onTroubleshoot}>
                  {t("feedback.troubleshoot")}
                </button>
              </p>
            )}
            <textarea className="input report-note" rows={6} autoFocus value={text} placeholder={t(PLACEHOLDER_KEY[kind])} aria-label={t("feedback.title")} onChange={(e) => setText(e.target.value)} />
            {app && <p className="meta-txt">{t("feedback.goesWith", { app: `Tomrade ${app.version} · ${app.os} · ${app.locale}` })}</p>}
            {send.error && <p className="ai-error">{readableError(send.error)}</p>}
          </>
        )}
      </DialogBody>
      <DialogFoot>
        {result ? (
          <button type="button" className="btn btn-primary" onClick={() => onOpenChange(false)}>
            {t("feedback.done")}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              {t("feedback.cancel")}
            </button>
            <button type="button" className="btn btn-primary" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? t("feedback.sending") : t("feedback.send")}
            </button>
          </>
        )}
      </DialogFoot>
    </Dialog>
  );
}
