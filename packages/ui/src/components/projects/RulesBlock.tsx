import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";

const MAX = 8000;

/** The project's rules file, edited in place; it saves on its own, apart from the sheet's Save. */
export function RulesBlock({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["agent", "rules", projectId] as const;
  const rules = useQuery({ queryKey: key, queryFn: () => invoke("agent.rules", projectId) });
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? rules.data?.body ?? "";
  const save = useMutation({
    mutationFn: (next: string) => invoke("agent.setRules", projectId, next),
    onSuccess: (saved) => {
      qc.setQueryData(key, saved);
      setDraft(null);
      toast({ body: t("projectRules.saved") });
    },
    onError: (err) => toast(errorSpec(err))
  });
  const dirty = draft !== null && draft.trim() !== (rules.data?.body ?? "");
  return (
    <div className="project-settings-section stack-3">
      <textarea
        className="textarea rules-input"
        data-testid="project-rules"
        aria-label={t("projectRules.label")}
        rows={10}
        maxLength={MAX}
        placeholder={t("projectRules.placeholder")}
        value={body}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <span className="meta-txt num">{t("projectRules.count", { n: body.length, max: MAX })}</span>
        <Spacer />
        <button type="button" className="btn btn-ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          {t("projectRules.revert")}
        </button>
        <button type="button" className="btn btn-primary" data-testid="save-rules" disabled={!dirty || save.isPending} onClick={() => save.mutate(body)}>
          {t("projectRules.save")}
        </button>
      </div>
      {rules.data?.file && <p className="meta-txt dense">{t("projectRules.where", { file: rules.data.file })}</p>}
      <p className="meta-txt dense">{t("projectRules.proposeNote")}</p>
    </div>
  );
}
