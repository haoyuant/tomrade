import { useCallback, useEffect } from "react";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useSaveSettings, useSettings } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/** "*" puts every hint and card away at once — what a check sets before the page loads. */
const ALL = "*";

/**
 * The hints and cards the person has already seen, from their own settings —
 * the onboarding plugin's user-scoped section — so one seen on this computer
 * is not taught again on the next. Until settings load, everything counts as
 * seen: a hint that flashes and vanishes is worse than one that waits a beat.
 */
export function useSeen() {
  const settings = useSettings();
  const save = useSaveSettings();
  const list = (settings.data?.onboarding as { seen?: string[] } | undefined)?.seen ?? [];
  const seen = useCallback((id: string) => !settings.data || list.includes(ALL) || list.includes(id), [settings.data, list]);
  const markSeen = useCallback(
    (id: string) => {
      if (!settings.data || seen(id)) return;
      save.mutate({ ...settings.data, onboarding: { seen: [...list, id] } });
    },
    [settings.data, seen, list, save]
  );
  return { seen, markSeen };
}

/** Raised this session already: a second mount (StrictMode, a second pane) must not raise it again before the save lands. */
const raised = new Set<string>();

/** A hint with nowhere to sit beside its subject: one toast, the first time `when` holds, and never again. */
export function useHintToast(id: string, when: boolean, message: MessageKey) {
  const { t } = useI18n();
  const { seen, markSeen } = useSeen();
  const toast = useToast();
  useEffect(() => {
    if (!when || seen(id) || raised.has(id)) return;
    raised.add(id);
    markSeen(id);
    toast({ body: t(message), sticky: true, actions: [{ label: t("onboarding.gotIt"), run: () => {} }] });
  }, [when, id, seen, markSeen, toast, t, message]);
}
