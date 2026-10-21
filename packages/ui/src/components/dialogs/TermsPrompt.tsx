import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogBody, DialogFoot } from "~/components/ui/dialog";
import { useAccount } from "~/lib/account";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { legalUrl } from "~/lib/legal";
import { openExternal } from "~/lib/shell";
import { keys } from "~/lib/queries";

/**
 * Asks a signed-in account that hasn't agreed to the current Terms of Service and
 * Privacy Policy — one from before they existed, or one since they changed. New
 * accounts agree on the sign-in form instead. It can't be dismissed: agree or sign out.
 */
export function TermsPrompt() {
  const { t, locale } = useI18n();
  const account = useAccount();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.account });
  const accept = useMutation({ mutationFn: () => invoke("account.acceptTerms"), onSuccess: refresh });
  const signOut = useMutation({ mutationFn: () => invoke("account.signOut"), onSettled: refresh });
  const info = account.data;
  // Dated versions sort as text; a newer one accepted elsewhere is never asked about again.
  const open = !!info?.user && !info.switchingTo && (info.terms.accepted ?? "") < info.terms.current;
  const busy = accept.isPending || signOut.isPending;

  return (
    <Dialog open={open} onOpenChange={() => {}} label={t("legal.promptTitle")} className="sheet-sm terms-prompt">
      {open && (
        <>
          <div className="dlg-head">
            <h2 className="dlg-title">{t("legal.promptTitle")}</h2>
          </div>
          <DialogBody className="stack-3">
            <p>{t(info.terms.accepted ? "legal.promptUpdated" : "legal.promptNew")}</p>
            <div className="row terms-prompt-links">
              <button type="button" className="link-btn" onClick={() => openExternal(legalUrl("terms", locale))}>
                {t("legal.terms")} ↗
              </button>
              <button type="button" className="link-btn" onClick={() => openExternal(legalUrl("privacy", locale))}>
                {t("legal.privacy")} ↗
              </button>
            </div>
            <p className="meta-txt">{t("legal.promptAsk")}</p>
            {accept.isError && (
              <p className="field-note is-error" role="alert">
                {t("legal.failed")}
              </p>
            )}
          </DialogBody>
          <DialogFoot>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => signOut.mutate()}>
              {t("legal.signOut")}
            </button>
            <button type="button" autoFocus className="btn btn-primary" disabled={busy} onClick={() => accept.mutate()}>
              {t("legal.agree")}
            </button>
          </DialogFoot>
        </>
      )}
    </Dialog>
  );
}
