import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";
import { keys } from "~/lib/queries";

/** The agent-maintained project brief, shown as every run reads it and edited in place; it saves on its own, apart from the sheet's Save. */
export function BriefBlock({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const key = keys.agent.brief(projectId);
  const brief = useQuery({ queryKey: key, queryFn: () => invoke("agent.brief", projectId) });
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? brief.data?.body ?? "";
  const max = brief.data?.max ?? 6000;
  const save = useMutation({
    mutationFn: (next: string) => invoke("agent.setBrief", projectId, next),
    onSuccess: (saved) => {
      qc.setQueryData(key, saved);
      setDraft(null);
      toast({ body: t("projectBrief.saved") });
    },
    onError: (err) => toast(errorSpec(err))
  });
  const dirty = draft !== null && draft.trim() !== (brief.data?.body ?? "");
  return (
    <div className="project-settings-section stack-3">
      <textarea
        className="textarea rules-input"
        data-testid="project-brief"
        aria-label={t("projectBrief.label")}
        rows={12}
        maxLength={max}
        placeholder={t("projectBrief.placeholder")}
        value={body}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <span className="meta-txt num">{t("projectBrief.count", { n: body.length, max })}</span>
        <Spacer />
        <button type="button" className="btn btn-ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          {t("projectBrief.revert")}
        </button>
        <button type="button" className="btn btn-primary" data-testid="save-brief" disabled={!dirty || save.isPending} onClick={() => save.mutate(body)}>
          {t("projectBrief.save")}
        </button>
      </div>
      <p className="meta-txt dense" data-testid="project-brief-updated">{brief.data?.updatedAt ? t("projectBrief.updated", { when: agoLabel(brief.data.updatedAt) }) : t("projectBrief.never")}</p>
    </div>
  );
}
