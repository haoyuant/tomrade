import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "@tomradex/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { keys, useSaveSettings, useSettings } from "~/lib/queries";
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
  const qc = useQueryClient();
  const settings = useSettings();
  const { mutate: save } = useSaveSettings();
  const list = useMemo(() => (settings.data?.onboarding as { seen?: string[] } | undefined)?.seen ?? [], [settings.data]);
  const seen = useCallback((id: string) => !settings.data || list.includes(ALL) || list.includes(id), [settings.data, list]);
  const markSeen = useCallback(
    (id: string) => {
      // From the newest settings, written back at once: two put away in one moment must both stay away.
      const current = qc.getQueryData<AppSettings>(keys.settings);
      const now = (current?.onboarding as { seen?: string[] } | undefined)?.seen ?? [];
      if (!current || now.includes(ALL) || now.includes(id)) return;
      const next = { ...current, onboarding: { seen: [...now, id] } };
      qc.setQueryData(keys.settings, next);
      save(next);
    },
    [qc, save]
  );
  return { seen, markSeen };
}

/** Raised this session already: a second mount (StrictMode, a second pane) must not raise it again before the save lands. */
const raised = new Set<string>();

/** Onboarding run again: the toasts raised this session may show once more. */
export const forgetRaisedHints = () => raised.clear();

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

/** Asked for by "Run onboarding again": the home shows the setup screen next, whatever is connected. */
let setupAsked = false;
const setupListeners = new Set<() => void>();
const setSetupAsked = (asked: boolean) => {
  setupAsked = asked;
  for (const listener of setupListeners) listener();
};
export const askForSetupScreen = () => setSetupAsked(true);
const takeSetupAsk = () => setSetupAsked(false);
const onSetupAsk = (listener: () => void) => {
  setupListeners.add(listener);
  return () => void setupListeners.delete(listener);
};

/** Whether the setup screen was asked for, and a way to take the ask once it shows. */
export function useSetupAsked(): [boolean, () => void] {
  return [useSyncExternalStore(onSetupAsk, () => setupAsked), takeSetupAsk];
}
