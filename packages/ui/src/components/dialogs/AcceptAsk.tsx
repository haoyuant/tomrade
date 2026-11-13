import { useEffect } from "react";
import { shouldAskAccept, useDevices } from "~/lib/devices";
import { useI18n } from "~/lib/i18n";
import { openSettingsPane } from "~/lib/settingsHost";
import { useToast } from "~/lib/toast";

/** Kept on this computer alone: each of the account's computers is asked for itself. */
const ASKED_KEY = "tomrade.devices.acceptAsked";
const wasAsked = (): boolean => {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return true;
  }
};

/**
 * Once the account has a second computer, this one is asked once whether it should take work from the
 * others. Accepting stays off: the answer opens the setting, where the person reads what it means and turns it on.
 */
export function AcceptAsk() {
  const { t } = useI18n();
  const toast = useToast();
  const devices = useDevices();
  useEffect(() => {
    if (!shouldAskAccept(devices.data, wasAsked())) return;
    try {
      localStorage.setItem(ASKED_KEY, "1");
    } catch {
      // A question that could not be remembered would come back every time: not asked at all.
      return;
    }
    toast({
      body: t("devices.acceptAsk"),
      sticky: true,
      actions: [
        // Once this click is over: it may have landed outside an open Settings sheet, which closes on it and would take the pane with it.
        { label: t("devices.acceptAskOpen"), run: () => void setTimeout(() => openSettingsPane("devices"), 0) },
        { label: t("devices.acceptAskNo"), run: () => {} }
      ]
    });
  }, [devices.data, toast, t]);
  return null;
}
