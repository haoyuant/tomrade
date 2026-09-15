import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomrade/domain";
import { invoke } from "~/lib/api";
import { invalidateWorkspace } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useI18n } from "~/lib/i18n";

/** File selection/preview belongs to Files; this panel presents delivery metadata. */
export function DeliveryPanel({ item }: { item: Item }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [report, setReport] = useState("");
  const [comment, setComment] = useState("");
  const [selected, setSelected] = useState<string[] | null>(null);
  const deliveries = useQuery({ queryKey: ["deliveries", item.projectId, item.id, item.version], queryFn: () => invoke("items.deliveries", item.projectId, item.id) });
  const current = deliveries.data?.find(d => d.state === "active") ?? deliveries.data?.at(-1);
  const evidence = item.evidence;
  const outputs = evidence.resources.filter(r => r.role === "output" && r.deliveryId === current?.id);
  const inputs = evidence.resources.filter(r => r.role === "input");
  const submission = evidence.submissions.filter(s => s.deliveryId === current?.id).at(-1);
  const review = evidence.reviews.find(r => r.submissionId === submission?.id);
  const open = item.status !== "done" && item.status !== "cancelled";
  const mutate = useMutation({
    mutationFn: async (action: "submit" | "accepted" | "changes-requested") => {
      if (action === "submit") return invoke("items.submitDelivery", item.projectId, item.id, { report, artifactIds: (selected ?? outputs.map(r => r.id)).filter(id => outputs.some(r => r.id === id)) });
      if (!submission) throw new Error(t("fields.noSubmission"));
      return invoke("items.reviewDelivery", item.projectId, item.id, { submissionId: submission.id, decision: action, comment }, item.version);
    },
    onSuccess: () => { setReport(""); setComment(""); setSelected(null); },
    onError: error => toast({ body: error.message }),
    onSettled: () => { invalidateWorkspace(qc, item.projectId); void qc.invalidateQueries({ queryKey: ["deliveries", item.projectId, item.id] }); }
  });
  if (item.kind !== "ticket") return null;
  return <section className="detail-sect stack-3" data-testid="delivery-panel" aria-label={t("fields.delivery")}>
    <h3>{t("fields.delivery")}{current ? ` · ${current.sequence}` : ""}</h3>
    {inputs.length > 0 && <div><span className="meta-txt">{t("fields.inputMaterials")}</span><ul>{inputs.map(r => <li key={r.id}>{r.name}</li>)}</ul></div>}
    {outputs.length > 0 && <div><span className="meta-txt">{t("fields.outputArtifacts")}</span><ul>{outputs.map(r => <li key={r.id}>
      {open && <input type="checkbox" aria-label={r.name} checked={(selected ?? outputs.map(o => o.id)).includes(r.id)} onChange={event => {
        const ids = selected ?? outputs.map(o => o.id);
        setSelected(event.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id));
      }} />} {r.name}
    </li>)}</ul></div>}
    {open && <div className="stack-2">
      <textarea className="input" data-testid="delivery-report" aria-label={t("fields.completionReport")} placeholder={t("fields.completionReport")} value={report} onChange={e => setReport(e.target.value)} />
      <button className="btn btn-secondary" data-testid="delivery-submit" type="button" disabled={!report.trim() || mutate.isPending || deliveries.isLoading} onClick={() => mutate.mutate("submit")}>{t("fields.submitReview")}</button>
    </div>}
    {open && item.status === "verifying" && submission && !review && <div className="stack-2">
      <p style={{ whiteSpace: "pre-wrap" }}>{submission.report}</p>
      <textarea className="input" aria-label={t("fields.reviewComment")} placeholder={t("fields.reviewComment")} value={comment} onChange={e => setComment(e.target.value)} />
      <div className="row">
        <button className="btn btn-primary" data-testid="delivery-accept" type="button" disabled={mutate.isPending} onClick={() => mutate.mutate("accepted")}>{t("fields.acceptDelivery")}</button>
        <button className="btn btn-secondary" data-testid="delivery-changes" type="button" disabled={mutate.isPending} onClick={() => mutate.mutate("changes-requested")}>{t("fields.requestChanges")}</button>
      </div>
    </div>}
    {evidence.submissions.length > 0 && <details><summary>{t("fields.deliveryHistory")}</summary>
      {evidence.submissions.map(s => {
        const r = evidence.reviews.find(candidate => candidate.submissionId === s.id);
        const sequence = deliveries.data?.find(d => d.id === s.deliveryId)?.sequence;
        return <div className="stack-2" key={s.id}>
          <p className="meta-txt">{sequence ? `${sequence} · ` : ""}{r ? t(r.decision === "accepted" ? "fields.accepted" : "fields.changesRequested") : t("fields.submitted")}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{s.report}</p>
          {s.artifactIds.length > 0 && <ul>{s.artifactIds.map(id => { const artifact = evidence.resources.find(a => a.id === id); return <li key={id} title={artifact?.file.versionId}>{artifact?.name ?? id}</li>; })}</ul>}
          {r?.comment && <p style={{ whiteSpace: "pre-wrap" }}>{r.comment}</p>}
        </div>;
      })}
    </details>}
  </section>;
}
