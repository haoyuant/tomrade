import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { forgetRaisedHints } from "~/lib/onboarding";
import { keys } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/** Onboarding from the top, as often as wanted; putting the sample back as it began is asked, since it deletes what was done there. */
export function RestartOnboardingDialog({ open, onOpenChange, hasSample, onRestarted }: { open: boolean; onOpenChange: (open: boolean) => void; hasSample: boolean; onRestarted: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [resetSample, setResetSample] = useState(true);
  const restart = useMutation({
    mutationFn: () => invoke("onboarding.restart", { resetSample: hasSample && resetSample, locale }),
    onSuccess: async () => {
      forgetRaisedHints();
      await Promise.all([qc.invalidateQueries({ queryKey: keys.projects }), qc.invalidateQueries({ queryKey: keys.settings })]);
      onOpenChange(false);
      onRestarted();
    },
    onError: (err) => toast({ body: err instanceof Error ? err.message : String(err) })
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("onboarding.restartTitle")}>
      <DialogHead title={t("onboarding.restartTitle")} />
      <DialogBody className="stack-3">
        <p className="meta-txt">{t("onboarding.restartBody")}</p>
        {hasSample ? (
          <label className="cfg-row" style={{ cursor: "pointer" }}>
            <input type="checkbox" data-testid="restart-reset-sample" checked={resetSample} onChange={(e) => setResetSample(e.target.checked)} />
            <span className="cfg-name">{t("onboarding.restartResetSample")}</span>
          </label>
        ) : (
          <p className="meta-txt">{t("onboarding.restartMakesSample")}</p>
        )}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-testid="restart-confirm" disabled={restart.isPending} onClick={() => restart.mutate()}>
          {t("onboarding.restartConfirm")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
