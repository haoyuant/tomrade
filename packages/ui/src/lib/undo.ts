import { STALE_UNDO } from "@tomradex/domain";
import { messageOf } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/**
 * A toast's Undo: takes back the one write the toast announced — named by the
 * stamp it left (an issue's version, a view's or workstream's updatedAt) — and
 * says what happened. Once something newer stands, it says so instead of
 * taking back that newer change.
 */
export function useToastUndo(projectId: string) {
  const undo = useUndo(projectId);
  const toast = useToast();
  const { t } = useI18n();
  return (target: { id: string; stamp: number }) =>
    undo.mutate(target, {
      onSuccess: (step) => toast({ body: step ? step.summary : t("toast.nothingToUndo") }),
      onError: (err) => toast({ body: messageOf(err).includes(STALE_UNDO) ? t("toast.changedSince") : messageOf(err) })
    });
}
