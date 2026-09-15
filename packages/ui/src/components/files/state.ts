import type { FilesSyncState } from "@tomrade/files";
import type { MessageKey } from "~/lib/i18n";

export interface StateView {
  label: string;
  tone: "faint" | "neutral" | "strong";
  hint: string;
  warn?: boolean;
}

/** Shape-coded first: a word carries the state and the tone only confirms. Those that need a person say so. */
export function stateOf(t: (key: MessageKey) => string): Record<FilesSyncState, StateView> {
  return {
    local: { label: t("files.stateLocalLabel"), tone: "neutral", hint: t("files.stateLocalHint") },
    synced: { label: t("files.stateSyncedLabel"), tone: "faint", hint: t("files.stateSyncedHint") },
    ahead: { label: t("files.stateAheadLabel"), tone: "neutral", hint: t("files.stateAheadHint") },
    behind: { label: t("files.stateBehindLabel"), tone: "neutral", hint: t("files.stateBehindHint") },
    diverged: { label: t("files.stateDivergedLabel"), tone: "strong", hint: t("files.stateDivergedHint"), warn: true },
    conflicted: { label: t("files.stateConflictedLabel"), tone: "strong", hint: t("files.stateConflictedHint"), warn: true },
    syncing: { label: t("files.stateSyncingLabel"), tone: "neutral", hint: t("files.stateSyncingHint") },
    offline: { label: t("files.stateOfflineLabel"), tone: "strong", hint: t("files.stateOfflineHint"), warn: true },
    error: { label: t("files.stateErrorLabel"), tone: "strong", hint: t("files.stateErrorHint"), warn: true },
    unavailable: { label: t("files.stateUnavailableLabel"), tone: "strong", hint: t("files.stateUnavailableHint"), warn: true }
  };
}
