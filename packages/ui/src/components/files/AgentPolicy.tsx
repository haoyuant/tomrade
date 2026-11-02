import { useIsMutating } from "@tanstack/react-query";
import { useState } from "react";
import type { FileEntry, FileListPreference, ListMode } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Collapse } from "~/components/ui/collapse";
import { ContextMenuActionItem } from "~/components/ui/menu";
import { useFilesAgentIndex, useFilesAgentPolicy, useSetAgentRules } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";
import { keys } from "~/lib/queries";

type Choice = ListMode | "inherit";
type Translate = ReturnType<typeof useI18n>["t"];

const CHOICES: { mode: Choice; label: "files.agentListed" | "files.agentUnlisted" | "files.agentInherit"; icon: "i-eye" | "i-eye-off" | "i-undo" }[] = [
  { mode: "listed", label: "files.agentListed", icon: "i-eye" },
  { mode: "unlisted", label: "files.agentUnlisted", icon: "i-eye-off" },
  { mode: "inherit", label: "files.agentInherit", icon: "i-undo" }
];

export type AgentActions = ReturnType<typeof useAgentActions>;

/**
 * One instance per surface. Nothing here asks for confirmation: leaving a path
 * out of the index removes no file, changes no permission, and is undone by
 * choosing again.
 */
export function useAgentActions(projectId: string) {
  const { t } = useI18n();
  const policy = useFilesAgentPolicy(projectId);
  const mutation = useSetAgentRules(projectId);
  const pending = useIsMutating({ mutationKey: keys.files.setAgentRules(projectId) }) > 0;
  const toast = useToast();
  const change = (paths: string[], mode: Choice) => {
    if (pending || !policy.data || !paths.length) return;
    mutation.mutate({ paths, mode }, { onSuccess: () => toast({ body: t("files.agentSaved") }), onError: (error) => toast(errorSpec(error)) });
  };
  return { policy, change, disabled: pending || policy.isError || !policy.data };
}

/** "Keep out of the index · Inherited from Private": the effective setting and where it comes from. */
export function describeListing(t: Translate, listing: FileListPreference): string {
  const source =
    listing.source === "explicit" ? t("files.syncExplicit") : listing.source === "inherited" ? t("files.syncFrom", { path: listing.sourcePath ?? "" }) : t("files.syncFromRoot");
  return `${t(listing.mode === "unlisted" ? "files.agentUnlisted" : "files.agentListed")} · ${source}${listing.mixed ? ` · ${t("files.agentMixed")}` : ""}`;
}

/**
 * Only an exception is marked. Listing is the default and the common case, so
 * a mark on every row would say nothing; a crossed-out eye says the one thing
 * worth noticing.
 */
export function AgentMark({ listing }: { listing?: FileListPreference }) {
  const { t } = useI18n();
  if (!listing || (listing.mode === "listed" && !listing.mixed)) return null;
  const kind = listing.mixed ? "mixed" : listing.mode;
  const title = describeListing(t, listing);
  return (
    <span className="sync-mark" data-access={kind} role="img" aria-label={title} title={title}>
      <Icon name="i-eye-off" size={12} style={kind === "mixed" ? { opacity: 0.5 } : undefined} />
    </span>
  );
}

/** A compact chooser for one path, a selection or, with `root`, the project default. */
export function AgentSelect({ actions, paths, value, label, root = false }: { actions: AgentActions; paths: string[]; value: Choice | ""; label: string; root?: boolean }) {
  const { t } = useI18n();
  return (
    <select
      className="input files-agent-select"
      style={{ width: "auto", display: "inline-block", padding: "3px 8px", fontSize: 13 }}
      aria-label={label}
      disabled={actions.disabled || !paths.length}
      value={value}
      onChange={(event) => actions.change(paths, event.target.value as Choice)}
    >
      <option value="" disabled>
        {t("files.agentChoose")}
      </option>
      {CHOICES.map((choice) => (
        <option key={choice.mode} value={choice.mode}>
          {t(root && choice.mode === "inherit" ? "files.agentResetRoot" : choice.label)}
        </option>
      ))}
    </select>
  );
}

/** Only the choices that would change something. */
export function AgentContextActions({ actions, paths, entry }: { actions: AgentActions; paths: string[]; entry?: FileEntry }) {
  const { t } = useI18n();
  const listing = paths.length === 1 ? entry?.listing : undefined;
  const choices = CHOICES.filter((choice) => !listing || (choice.mode === "inherit" ? listing.source === "explicit" : choice.mode !== listing.mode));
  return (
    <>
      {choices.map((choice) => (
        <ContextMenuActionItem
          key={choice.mode}
          icon={<Icon name={choice.icon} size={13} />}
          name={t(choice.label)}
          disabled={actions.disabled || !paths.length}
          onSelect={() => actions.change(paths, choice.mode)}
        />
      ))}
    </>
  );
}

/** The project default, its exceptions, and the text an agent actually receives. */
export function AgentPolicySettings({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const actions = useAgentActions(projectId);
  const { policy } = actions;
  const [open, setOpen] = useState(false);
  const index = useFilesAgentIndex(projectId, open);
  const toast = useToast();
  return (
    <div className="stack-3 files-agent-settings">
      <p className="eyebrow">{t("files.agentRoot")}</p>
      {policy.isError ? (
        <p className="meta-txt" role="status">
          {t(/does not|unavailable/i.test(policy.error.message) ? "files.agentUnsupported" : "files.agentPolicyError")}{" "}
          <button type="button" className="btn btn-ghost" onClick={() => void policy.refetch()}>
            {t("files.syncRetry")}
          </button>
        </p>
      ) : (
        <div className="row" style={{ gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <AgentSelect actions={actions} paths={[""]} value={policy.data?.default ?? ""} label={t("files.agentRoot")} root />
          {policy.data && <span className="meta-txt">{t("files.agentRuleCount", { n: policy.data.rules.length })}</span>}
        </div>
      )}
      <p className="meta-txt dense">{t("files.agentHelp")}</p>
      <div className="row" style={{ gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost files-agent-preview-toggle" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {t(open ? "files.agentIndexHide" : "files.agentIndexShow")}
        </button>
        {open && index.data && <span className="meta-txt">{t("files.agentIndexCount", { tokens: index.data.tokens, listed: index.data.listed, total: index.data.total })}</span>}
        {open && index.data && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(index.data!.markdown);
              toast({ body: t("files.agentIndexCopied") });
            }}
          >
            {t("files.agentIndexCopy")}
          </button>
        )}
      </div>
      <Collapse open={open} as="pre" className="files-agent-preview" aria-label={t("files.agentIndexTitle")}>
        {index.isLoading ? "…" : index.data ? index.data.markdown : t("files.agentIndexEmpty")}
      </Collapse>
    </div>
  );
}
