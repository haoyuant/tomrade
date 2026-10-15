import { useState } from "react";
import { useConnectRepository, useRepositoryConnection } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { openExternal } from "~/lib/shell";

/** Shared by the repository row and the workstream's quiet setup hint. */
export function AgentConnection({ projectId, repoId, hint = false }: { projectId: string; repoId: string; hint?: boolean }) {
  const { t } = useI18n();
  const connection = useRepositoryConnection(projectId, repoId);
  const connect = useConnectRepository(projectId, repoId);
  const hintKey = `tomrade-agent-connection:${projectId}:${repoId}`;
  const [dismissed, dismiss] = useState(() => localStorage.getItem(hintKey) === "dismissed");
  const view = connection.data;
  if (hint && (dismissed || !view || view.state === "connected")) return null;
  const url = connect.data?.url ?? view?.url;
  const state = view?.state;
  return (
    <div className="stack-2 repo-agent-connection" data-testid="repo-agent-connection" data-state={state} style={{ marginTop: "var(--space-3)" }}>
      <div className="row">
        <strong className="cfg-name">{state ? t(`repositories.connection_${state}`) : t("repositories.connectionChecking")}</strong>
        {hint && <button type="button" className="btn btn-ghost" onClick={() => { localStorage.setItem(hintKey, "dismissed"); dismiss(true); }}>{t("repositories.connectionDismiss")}</button>}
      </div>
      {view?.mcpUrl && <p className="meta-txt dense" style={{ overflowWrap: "anywhere" }}>{t(view.instance === "packaged" ? "repositories.connectionPackaged" : "repositories.connectionDevelopment")} · {view.mcpUrl}</p>}
      {view?.configuredUrl && view.configuredUrl !== view.mcpUrl && <p className="meta-txt dense" style={{ overflowWrap: "anywhere" }}>{t("repositories.connectionElsewhere", { url: view.configuredUrl })}</p>}
      {state === "connected" && view?.claudeApproval && view.claudeApproval !== "approved" && (
        <p className="meta-txt dense cli-warn repo-agent-approval" data-approval={view.claudeApproval}>
          {t(view.claudeApproval === "pending" ? "repositories.claudeApprovalPending" : "repositories.claudeApprovalRejected")}
        </p>
      )}
      {state && state !== "connected" && <>
        <p className="meta-txt dense">{t("repositories.connectionFiles")}</p>
        <button type="button" className="btn btn-secondary repo-agent-connect" disabled={connect.isPending || state === "no-checkout" || state === "unavailable"} onClick={() => connect.mutate()}>
          {connect.isPending ? t("repositories.connectionWorking") : state === "pending" ? t("repositories.connectionRetry") : t("repositories.connectionAction")}
        </button>
      </>}
      <button type="button" className="btn btn-ghost" disabled={connection.isFetching} onClick={() => void connection.refetch()}>{t("repositories.connectionRefresh")}</button>
      {connection.error && <p role="alert" className="meta-txt">{connection.error.message}</p>}
      {connect.error && <p role="alert" className="meta-txt">{connect.error.message}</p>}
      {(connect.data?.agents ?? view?.agents ?? []).map((agent) => <p className="meta-txt dense repo-agent-capability" key={agent.id} data-agent={agent.id}>
        <strong>{agent.title}</strong> · {t(agent.tools ? "repositories.agentTools" : agent.instructions ? "repositories.agentInstructions" : "repositories.agentNotConfigured")} · {t(agent.tracking === "hooks" ? "repositories.agentHooks" : "repositories.agentNoTracking")}
        {agent.reviewHooks && agent.tracking === "hooks" && <> · {t("repositories.agentReviewHooks")}</>}
      </p>)}
      {connect.data && <p role="status" className="meta-txt repo-agent-result">{connect.data.message}</p>}
      {url && <button type="button" className="btn btn-ghost repo-agent-pr" onClick={() => openExternal(url)}>{t("repositories.connectionPr")}</button>}
    </div>
  );
}
