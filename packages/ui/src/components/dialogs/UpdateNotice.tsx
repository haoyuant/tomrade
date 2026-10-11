import { useEffect, useRef } from "react";
import { useI18n } from "~/lib/i18n";
import { useToast, useToastDismiss } from "~/lib/toast";
import { updatesOnScreen, useUpdateActions, useUpdateStatus } from "~/lib/updates";

/**
 * Says so once per version and step: a newer release is out, then it is
 * downloaded. Nothing happens until the person picks; Later leaves it to the
 * About pane — and, once downloaded, to the next quit. While the About pane is
 * open it already says as much, and a toast's click would close the dialog.
 */
export function UpdateNotice() {
  const { t } = useI18n();
  const toast = useToast();
  const dismiss = useToastDismiss();
  const status = useUpdateStatus();
  const { download, install } = useUpdateActions();
  const seen = useRef(new Set<string>());
  const shown = useRef<{ key: string; id: number } | null>(null);
  const phase = status.data?.phase;
  const key = phase?.kind === "available" || phase?.kind === "ready" ? `${phase.kind}:${phase.version}` : null;

  useEffect(() => {
    if (shown.current && shown.current.key !== key) {
      dismiss(shown.current.id);
      shown.current = null;
    }
    if (!key || !phase || seen.current.has(key) || (phase.kind !== "available" && phase.kind !== "ready")) return;
    seen.current.add(key);
    if (updatesOnScreen()) return;
    const later = { label: t("about.later"), run: () => {} };
    const id =
      phase.kind === "available"
        ? toast({ body: t("about.noticeAvailable", { version: phase.version }), sticky: true, actions: [{ label: t("about.download"), run: () => download.mutate() }, later] })
        : toast({ body: t("about.noticeReady", { version: phase.version }), sticky: true, actions: [{ label: t("about.restartNow"), run: () => install.mutate() }, later] });
    shown.current = { key, id };
    // The phase object changes on every progress tick; the key is what decides.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
