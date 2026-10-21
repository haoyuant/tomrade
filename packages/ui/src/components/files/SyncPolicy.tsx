import { useIsMutating } from "@tanstack/react-query";
import { useState } from "react";
import type { FileEntry, FileSyncPreference, SyncMode } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { ContextMenuActionItem } from "~/components/ui/menu";
import { useFilesSyncPolicy, useFilesTree, useSetSyncRules } from "~/lib/files";
import { makesPathsLocal, syncFileCounts } from "~/lib/files-sync-policy";
import { useI18n } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";
import { keys } from "~/lib/queries";

type Choice = SyncMode | "inherit";
type Translate = ReturnType<typeof useI18n>["t"];

const CHOICES: { mode: Choice; label: "files.syncShared" | "files.syncLocal" | "files.syncInherit"; icon: "i-cloud" | "i-monitor" | "i-undo" }[] = [
  { mode: "shared", label: "files.syncShared", icon: "i-cloud" },
  { mode: "local", label: "files.syncLocal", icon: "i-monitor" },
  { mode: "inherit", label: "files.syncInherit", icon: "i-undo" }
];

export type SyncActions = ReturnType<typeof useSyncActions>;

/**
 * One instance per surface, shared by every control on it. A change asks
 * first only when something now shared would leave the remote; sharing more,
 * or resetting a rule that changes nothing, just happens.
 */
export function useSyncActions(projectId: string) {
  const { t } = useI18n();
  const policy = useFilesSyncPolicy(projectId);
  const mutation = useSetSyncRules(projectId);
  const pending = useIsMutating({ mutationKey: keys.files.setSyncRules(projectId) }) > 0;
  const toast = useToast();
  const [review, setReview] = useState<{ paths: string[]; mode: Choice } | null>(null);
  const save = (paths: string[], mode: Choice) => {
    if (pending) return;
    mutation.mutate(
      { paths, mode },
      {
        onSuccess: () => {
          setReview(null);
          toast({ body: t("files.syncPolicySaved") });
        },
        onError: (error) => toast(errorSpec(error))
      }
    );
  };
  const change = (paths: string[], mode: Choice) => {
    if (pending || !policy.data || !paths.length) return;
    if (makesPathsLocal(policy.data, paths, mode)) setReview({ paths: [...paths], mode });
    else save(paths, mode);
  };
  const confirmation = (
    <Dialog
      open={!!review}
      onOpenChange={(open) => {
        if (!open && !pending) setReview(null);
      }}
      label={t("files.syncReviewTitle")}
      className="sheet-md files-sync-review"
    >
      <DialogHead title={t("files.syncReviewTitle")} />
      <DialogBody>
        <p>{t("files.syncLocalConfirm", { n: review?.paths.length ?? 0 })}</p>
      </DialogBody>
      <DialogFoot>
        <button type="button" autoFocus className="btn btn-secondary" disabled={pending} onClick={() => setReview(null)}>
          {t("files.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={pending}
          onClick={() => {
            if (review) save(review.paths, review.mode);
          }}
        >
          {t("files.syncLocal")}
        </button>
      </DialogFoot>
    </Dialog>
  );
  return { policy, change, confirmation, disabled: pending || policy.isError || !policy.data };
}

/** "Keep local · Inherited from drafts": the effective setting and where it comes from. */
export function describeSync(t: Translate, sync: FileSyncPreference): string {
  const source = sync.source === "explicit" ? t("files.syncExplicit") : sync.source === "inherited" ? t("files.syncFrom", { path: sync.sourcePath ?? "" }) : t("files.syncFromRoot");
  return `${t(sync.mode === "local" ? "files.syncLocal" : "files.syncShared")} · ${source}${sync.mixed ? ` · ${t("files.syncMixed")}` : ""}`;
}

/** After every name, one of three marks: a cloud for what shares, a monitor for what stays here, a half cloud for a folder holding both. */
export function SyncMark({ sync }: { sync?: FileSyncPreference }) {
  const { t } = useI18n();
  if (!sync) return null;
  const kind = sync.mixed ? "mixed" : sync.mode;
  const title = describeSync(t, sync);
  return (
    <span className="sync-mark" data-sync={kind} role="img" aria-label={title} title={title}>
      <Icon name={kind === "mixed" ? "i-cloud-half" : kind === "local" ? "i-monitor" : "i-cloud"} size={12} />
    </span>
  );
}

/** A compact chooser for one path, a selection or, with `root`, the project default. With an empty `value` it acts as a menu. */
export function SyncSelect({ actions, paths, value, label, root = false }: { actions: SyncActions; paths: string[]; value: Choice | ""; label: string; root?: boolean }) {
  const { t } = useI18n();
  return (
    <select
      className="input files-sync-select"
      style={{ width: "auto", display: "inline-block", padding: "3px 8px", fontSize: 13 }}
      aria-label={label}
      disabled={actions.disabled || !paths.length}
      value={value}
      onChange={(event) => actions.change(paths, event.target.value as Choice)}
    >
      <option value="" disabled>
        {t("files.syncChoose")}
      </option>
      {CHOICES.map((choice) => (
        <option key={choice.mode} value={choice.mode}>
          {t(root && choice.mode === "inherit" ? "files.syncResetRoot" : choice.label)}
        </option>
      ))}
    </select>
  );
}

/** Only the choices that would change something: no "Shared" for what is shared, no "Inherit" without a rule to drop. */
export function SyncContextActions({ actions, paths, entry }: { actions: SyncActions; paths: string[]; entry?: FileEntry }) {
  const { t } = useI18n();
  const sync = paths.length === 1 ? entry?.sync : undefined;
  const choices = CHOICES.filter((choice) => !sync || (choice.mode === "inherit" ? sync.source === "explicit" : choice.mode !== sync.mode));
  return (
    <>
      {choices.map((choice) => (
        <ContextMenuActionItem key={choice.mode} icon={<Icon name={choice.icon} size={13} />} name={t(choice.label)} disabled={actions.disabled || !paths.length} onSelect={() => actions.change(paths, choice.mode)} />
      ))}
    </>
  );
}

/** How many files share and how many stay, for the sharing card and before a first bind pushes. */
export function SyncScopeSummary({ projectId, binding = false }: { projectId: string; binding?: boolean }) {
  const { t } = useI18n();
  const tree = useFilesTree(projectId);
  const policy = useFilesSyncPolicy(projectId);
  const counts = tree.data ? syncFileCounts(tree.data, policy.data) : null;
  return (
    <div className="meta-txt dense files-sync-summary" role="status">
      <p>{counts && !counts.unknown && !tree.isError ? t("files.syncScopeCounts", counts) : t("files.syncScopeUnavailable")}</p>
      {binding && <p>{t("files.syncBindReview")}</p>}
    </div>
  );
}

/** The project default and its exceptions, in Sharing. */
export function SyncPolicySettings({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const actions = useSyncActions(projectId);
  const { policy } = actions;
  return (
    <div className="stack-3 files-sync-settings">
      {actions.confirmation}
      <p className="eyebrow">{t("files.syncRoot")}</p>
      {policy.isError ? (
        <p className="meta-txt" role="status">
          {t(/does not support/i.test(policy.error.message) ? "files.syncUnsupported" : "files.syncPolicyError")}{" "}
          <button type="button" className="btn btn-ghost" onClick={() => void policy.refetch()}>
            {t("files.syncRetry")}
          </button>
        </p>
      ) : (
        <div className="row" style={{ gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <SyncSelect actions={actions} paths={[""]} value={policy.data?.default ?? ""} label={t("files.syncRoot")} root />
          {policy.data && <span className="meta-txt">{t("files.syncRuleCount", { n: policy.data.rules.length })}</span>}
        </div>
      )}
      <p className="meta-txt dense">{t("files.syncPolicyHelp")}</p>
    </div>
  );
}
