import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { readableError } from "~/lib/toast";

type Include = { environment: boolean; checks: boolean; error: boolean; logs: boolean; conversation: boolean };
const SECTIONS: (keyof Include)[] = ["error", "checks", "environment", "logs", "conversation"];
// The failed conversation may hold the person's own work: it goes only when ticked.
const DEFAULTS: Include = { environment: true, checks: true, error: true, logs: true, conversation: false };

/**
 * What would reach Tomrade's developer, shown before it goes: every section
 * the person can untick, a note of their own, and the exact text. Nothing is
 * sent until Send; a report that can't go now waits and goes later.
 */
export function ReportDialog({ projectId, threadId, onOpenChange }: { projectId: string; threadId: string | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const [include, setInclude] = useState<Include>(DEFAULTS);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setInclude(DEFAULTS);
    setNote("");
  }, [threadId]);
  const preview = useQuery({
    queryKey: ["doctor-report", projectId, threadId, include, note],
    queryFn: () => invoke("doctor.preview", projectId, threadId!, include, note),
    enabled: !!threadId,
    placeholderData: (previous) => previous
  });
  const send = useMutation({ mutationFn: () => invoke("doctor.send", projectId, threadId!, include, note) });
  useEffect(() => send.reset(), [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = (preview.data?.sections ?? []).map((s) => `── ${s.title} ──\n${s.text}`).join("\n\n");
  const copy = () => void navigator.clipboard?.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });
  const result = send.data;

  return (
    <Dialog open={!!threadId} onOpenChange={onOpenChange} label={t("doctor.reportTitle")} className="sheet-report">
      <DialogHead title={t("doctor.reportTitle")} />
      <DialogBody className="stack-3">
        {result ? (
          <div className="stack-2 report-result" role="status">
            <p className="dlg-sub">
              <Icon name={result.state === "sent" ? "i-check" : "i-clock"} size={14} /> {result.state === "sent" ? t("doctor.sent", { code: result.code }) : t("doctor.queued", { code: result.code })}
            </p>
            <p className="meta-txt">{result.state === "sent" ? t("doctor.sentNext") : t("doctor.queuedWhy", { reason: result.reason ?? "" })}</p>
          </div>
        ) : (
          <>
            <p className="meta-txt">{t("doctor.reportLede")}</p>
            <fieldset className="report-sections">
              {SECTIONS.map((id) => (
                <label key={id} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={include[id]} onChange={(e) => setInclude({ ...include, [id]: e.target.checked })} />
                  <span>{t(`doctor.section_${id}` as MessageKey)}</span>
                  {id === "conversation" && <span className="meta-txt">{t("doctor.conversationHint")}</span>}
                </label>
              ))}
            </fieldset>
            <textarea className="input report-note" rows={3} placeholder={t("doctor.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
            <pre className="report-preview" aria-label={t("doctor.previewLabel")}>{text || t("doctor.empty")}</pre>
            {send.error && <p className="ai-error">{readableError(send.error)}</p>}
          </>
        )}
      </DialogBody>
      <DialogFoot>
        {result ? (
          <button type="button" className="btn btn-primary" onClick={() => onOpenChange(false)}>{t("doctor.done")}</button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={copy} disabled={!text}>
              <Icon name="i-copy" size={12} /> {copied ? t("agentPanel.errorCopied") : t("doctor.copy")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>{t("doctor.cancel")}</button>
            <button type="button" className="btn btn-primary" disabled={!text || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? t("doctor.sending") : t("doctor.send")}
            </button>
          </>
        )}
      </DialogFoot>
    </Dialog>
  );
}
