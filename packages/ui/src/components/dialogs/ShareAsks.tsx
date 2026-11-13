import { useEffect, useRef } from "react";
import { useAskActions, useAsks } from "~/lib/devices";
import { useI18n } from "~/lib/i18n";
import { openSettingsPane } from "~/lib/settingsHost";
import { errorSpec, useToast } from "~/lib/toast";

/**
 * A person this computer is shared with asks it to work a ticket: said once, wherever the owner is in the app,
 * with the yes and the no. It stays in Settings → Devices until answered.
 */
export function ShareAsks() {
  const { t } = useI18n();
  const toast = useToast();
  const asks = useAsks();
  const { approve, decline } = useAskActions();
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const ask of asks.data ?? []) {
      if (told.current.has(ask.id)) continue;
      told.current.add(ask.id);
      const failed = (error: unknown) => toast(errorSpec(error));
      toast({
        body: `${t("devices.askLine", { who: ask.fromEmail ?? "", key: ask.key, title: ask.title })} ${t("devices.askMeans")}`,
        sticky: true,
        actions: [
          { label: t("devices.askYes"), run: () => approve.mutate(ask.id, { onError: failed }) },
          { label: t("devices.askNo"), run: () => decline.mutate(ask.id, { onError: failed }) },
          { label: t("devices.askOpen"), run: () => void setTimeout(() => openSettingsPane("devices"), 0) }
        ]
      });
    }
  }, [asks.data, approve, decline, toast, t]);
  return null;
}
