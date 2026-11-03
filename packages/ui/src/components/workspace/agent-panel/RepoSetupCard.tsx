import { useState } from "react";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";
import { Icon } from "~/components/icons";
import { message } from "~/components/projects/destination";
import { useChooseRepoFolder, useLinkLoneWorkstream } from "~/components/projects/RepositoriesBlock";
import { useI18n } from "~/lib/i18n";
import { isCommitKey } from "~/lib/keys";
import { useCreateRepo, useRepos } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/**
 * A project with no code repository: add one here, from a folder or a remote's URL. The main conversation
 * offers it once (skippable); an agent whose work needs the code puts it in the conversation again.
 */
export function RepoSetupCard({ projectId, reason, onOpenRepositories, onSkip }: {
  projectId: string;
  /** Why the agent asked for it now. */
  reason?: string;
  onOpenRepositories?: () => void;
  onSkip?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const repos = useRepos(projectId);
  const create = useCreateRepo(projectId);
  const folder = useChooseRepoFolder(projectId);
  const autoLink = useLinkLoneWorkstream(projectId);
  const [url, setUrl] = useState("");
  if (!repos.data) return null;
  if (repos.data.length) {
    return (
      <div className="tool-card" data-testid="repo-setup-done">
        <p className="tool-row meta-txt">
          <Icon name="i-check" size={12} /> {t("agentPanel.repoSetupDone", { names: repos.data.map((r) => r.name).join(", ") })}
        </p>
      </div>
    );
  }
  const add = () => {
    const remote = url.trim();
    if (!remote || create.isPending) return;
    create.mutate({ remote }, {
      onSuccess: (repo) => {
        setUrl("");
        toast({ body: t("repositories.addedToast", { name: repo.name }) });
        autoLink(repo);
      },
      onError: (error) => toast({ body: message(error) })
    });
  };
  return (
    <div className="tool-card repo-setup" data-testid="repo-setup">
      <div className="tool-head">
        <Icon name="i-branch" size={12} />
        {t("agentPanel.repoSetupTitle")}
      </div>
      {reason && <p className="tool-row" data-testid="repo-setup-reason">{reason}</p>}
      <p className="tool-row meta-txt">{t("agentPanel.repoSetupLead")}</p>
      <div className="tool-row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-xs" data-testid="repo-setup-folder" disabled={folder.busy} onClick={() => void folder.choose().then((added) => added && !added.existing && autoLink(added.repo))}>
          <Icon name="i-folder" size={12} /> {folder.busy ? t("repositories.choosing") : t("agentPanel.repoSetupFolder")}
        </button>
        {onOpenRepositories && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={onOpenRepositories}>
            {t("agentPanel.repoSetupMore")}
          </button>
        )}
        {onSkip && (
          <button type="button" className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }} data-testid="repo-setup-skip" onClick={onSkip}>
            {t("agentPanel.repoSetupSkip")}
          </button>
        )}
      </div>
      <div className="tool-row">
        <input
          className="input num"
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("agentPanel.repoSetupUrlAria")}
          placeholder={t("agentPanel.repoSetupUrlPlaceholder")}
          value={url}
          data-testid="repo-setup-url"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (isCommitKey(e)) add();
          }}
        />
        <button type="button" className="btn btn-ghost btn-xs" disabled={!url.trim() || create.isPending} onClick={add}>
          <Icon name="i-plus" size={12} /> {t("agentPanel.repoSetupAdd")}
        </button>
      </div>
    </div>
  );
}

/** The card an agent's offer_repository put in the conversation. */
export function RepoSetupBlock({ projectId, data }: { projectId: string; data: unknown }) {
  const dock = useOptionalAgentDock();
  const reason = (data as { reason?: unknown } | null)?.reason;
  return <RepoSetupCard projectId={projectId} reason={typeof reason === "string" ? reason : undefined} onOpenRepositories={dock?.openRepositories} />;
}
