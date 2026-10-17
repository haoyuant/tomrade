import { useState } from "react";
import { useConnectRepository, useRepositoryConnection } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { openExternal } from "~/lib/shell";
import { readableError } from "~/lib/toast";

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
  // Per Claude Code config folder when this Tomrade knows them; the single answer otherwise.
  const approvals = view?.claudeApprovals ?? (view?.claudeApproval ? [{ profile: "", state: view.claudeApproval, command: "claude" }] : []);
  const unapproved = approvals.filter((a) => a.state !== "approved");
  // A taken port leaves this Tomrade on one that changes at every restart; Connect refuses to write it.
  const held = view?.clash?.heldBy;
  const clash = view?.clash && t("repositories.connectionPortClash", { port: view.clash.port, holder: held ? t(`repositories.connectionHolder_${held.kind}`, { version: held.version, pid: held.pid }) : t("repositories.connectionHolderUnknown") });
  return (
    <div className="stack-2 repo-agent-connection" data-testid="repo-agent-connection" data-state={state} style={{ marginTop: "var(--space-3)" }}>
      <div className="row">
        <strong className="cfg-name">{state ? t(`repositories.connection_${state}`) : t("repositories.connectionChecking")}</strong>
        {hint && <button type="button" className="btn btn-ghost" onClick={() => { localStorage.setItem(hintKey, "dismissed"); dismiss(true); }}>{t("repositories.connectionDismiss")}</button>}
      </div>
      {view?.mcpUrl && <p className="meta-txt dense" style={{ overflowWrap: "anywhere" }}>{t(view.instance === "packaged" ? "repositories.connectionPackaged" : "repositories.connectionDevelopment")} · {view.mcpUrl}</p>}
      {view?.configuredUrl && view.configuredUrl !== view.mcpUrl && <p className="meta-txt dense" style={{ overflowWrap: "anywhere" }}>{t("repositories.connectionElsewhere", { url: view.configuredUrl })}</p>}
      {state === "connected" && unapproved.map((approval) => (
        <p className="meta-txt dense cli-warn repo-agent-approval" data-approval={approval.state} data-profile={approval.profile || undefined} key={approval.profile}>
          {approvals.length > 1 && <><strong className="mono">{approval.profile.split(/[\\/]/).filter(Boolean).at(-1)}</strong> · </>}
          {t(approval.state === "pending" ? "repositories.claudeApprovalPending" : "repositories.claudeApprovalRejected", { command: approval.command })}
        </p>
      ))}
      {state && state !== "connected" && <>
        <p className="meta-txt dense">{t("repositories.connectionFiles")}</p>
        {clash && <p className="meta-txt dense cli-warn repo-agent-clash">{clash}</p>}
        <button type="button" className="btn btn-secondary repo-agent-connect" disabled={connect.isPending || state === "no-checkout" || state === "unavailable" || !!clash} onClick={() => connect.mutate()}>
          {connect.isPending ? t("repositories.connectionWorking") : state === "pending" ? t("repositories.connectionRetry") : t("repositories.connectionAction")}
        </button>
      </>}
      <button type="button" className="btn btn-ghost" disabled={connection.isFetching} onClick={() => void connection.refetch()}>{t("repositories.connectionRefresh")}</button>
      {connection.error && <p role="alert" className="meta-txt">{readableError(connection.error)}</p>}
      {connect.error && <p role="alert" className="meta-txt">{readableError(connect.error)}</p>}
      {(connect.data?.agents ?? view?.agents ?? []).map((agent) => <p className="meta-txt dense repo-agent-capability" key={agent.id} data-agent={agent.id}>
        <strong>{agent.title}</strong> · {t(agent.tools ? "repositories.agentTools" : agent.instructions ? "repositories.agentInstructions" : "repositories.agentNotConfigured")} · {t(agent.tracking === "hooks" ? "repositories.agentHooks" : "repositories.agentNoTracking")}
        {agent.reviewHooks && agent.tracking === "hooks" && <> · {t("repositories.agentReviewHooks")}</>}
      </p>)}
      {connect.data && <p role="status" className="meta-txt repo-agent-result">{connect.data.message}</p>}
      {url && <button type="button" className="btn btn-ghost repo-agent-pr" onClick={() => openExternal(url)}>{t("repositories.connectionPr")}</button>}
    </div>
  );
}
