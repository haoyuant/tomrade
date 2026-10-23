import { useState } from "react";
import type { ConnectionView, SkipReason } from "@tomradex/code-link";
import type { InstanceBadge } from "@tomradex/mcp";
import { useChooseConnectAgents, useConnectRepository, useRepositoryConnection } from "~/lib/codeLink";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { openExternal } from "~/lib/shell";
import { readableError } from "~/lib/toast";

const STATE_KEY: Record<ConnectionView["state"], MessageKey> = {
  unconnected: "repositories.connection_unconnected",
  connected: "repositories.connection_connected",
  pending: "repositories.connection_pending",
  "other-instance": "repositories.connection_other-instance",
  "no-checkout": "repositories.connection_no-checkout",
  unavailable: "repositories.connection_unavailable"
};
const HOLDER_KEY: Record<InstanceBadge["kind"], MessageKey> = { packaged: "repositories.connectionHolder_packaged", dev: "repositories.connectionHolder_dev" };
// "no-connector" comes worded from code-link.
const SKIPPED_KEY: Record<Exclude<SkipReason, "no-connector">, MessageKey> = {
  tracked: "repositories.agentSkipped_tracked",
  comments: "repositories.agentSkipped_comments",
  invalid: "repositories.agentSkipped_invalid",
  "codex-hooks": "repositories.agentSkipped_codex-hooks"
};

/** Shared by the repository row and the workstream's quiet setup hint. */
export function AgentConnection({ projectId, repoId, hint = false }: { projectId: string; repoId: string; hint?: boolean }) {
  const { t } = useI18n();
  const connection = useRepositoryConnection(projectId, repoId);
  const connect = useConnectRepository(projectId, repoId);
  const choose = useChooseConnectAgents(projectId, repoId);
  const hintKey = `tomrade-agent-connection:${projectId}:${repoId}`;
  const [dismissed, dismiss] = useState(() => localStorage.getItem(hintKey) === "dismissed");
  const view = connection.data;
  if (hint && (dismissed || !view || view.state === "connected")) return null;
  const url = connect.data?.url ?? view?.url;
  const state = view?.state;
  const connected = state === "connected";
  // Per Claude Code config folder when this Tomrade knows them; the single answer otherwise.
  const approvals = view?.claudeApprovals ?? (view?.claudeApproval ? [{ profile: "", state: view.claudeApproval, command: "claude" }] : []);
  const unapproved = approvals.filter((a) => a.state !== "approved");
  // A taken port leaves this Tomrade on one that changes at every restart; Connect refuses to write it.
  const held = view?.clash?.heldBy;
  const clash = view?.clash && (view.clash.reserved ? t("repositories.connectionPortReserved", { port: view.clash.port }) : t("repositories.connectionPortClash", { port: view.clash.port, holder: held ? t(HOLDER_KEY[held.kind], { version: held.version, pid: held.pid }) : t("repositories.connectionHolderUnknown") }));
  // The live view, so a changed choice shows at once; the last chosen agent cannot be unchecked.
  const agents = view?.agents ?? connect.data?.agents ?? [];
  const chosen = agents.filter((agent) => agent.chosen).map((agent) => agent.id);
  // Connected, yet this machine never heard their hooks: the files alone do not prove an agent reports.
  const silent = connected ? agents.filter((agent) => agent.chosen && agent.tracking === "hooks" && !agent.lastEventAt) : [];
  const busy = connect.isPending || state === "no-checkout" || state === "unavailable" || !!clash;
  const working = (mode: "local" | "team") => connect.isPending && (connect.variables ?? "team") === mode;
  return (
    <div className="stack-2 repo-agent-connection" data-testid="repo-agent-connection" data-state={state} data-local={view?.local || undefined} style={{ marginTop: "var(--space-3)" }}>
      <div className="row">
        <strong className="cfg-name">{connected && view?.local ? t("repositories.connectionLocal") : state ? t(STATE_KEY[state]) : t("repositories.connectionChecking")}</strong>
        {hint && <button type="button" className="btn btn-ghost" onClick={() => { localStorage.setItem(hintKey, "dismissed"); dismiss(true); }}>{t("repositories.connectionDismiss")}</button>}
      </div>
      {view?.mcpUrl && <p className="meta-txt dense" style={{ overflowWrap: "anywhere" }}>{t(view.instance === "packaged" ? "repositories.connectionPackaged" : "repositories.connectionDevelopment")} · {view.mcpUrl}</p>}
      {view?.configuredUrl && view.configuredUrl !== view.mcpUrl && <p className="meta-txt dense repo-agent-elsewhere" style={{ overflowWrap: "anywhere" }}>{t(connected ? "repositories.connectionOtherPort" : "repositories.connectionElsewhere", { url: view.configuredUrl })}</p>}
      {connected && unapproved.map((approval) => (
        <p className="meta-txt dense cli-warn repo-agent-approval" data-approval={approval.state} data-profile={approval.profile || undefined} key={approval.profile}>
          {approvals.length > 1 && <><strong className="mono">{approval.profile.split(/[\\/]/).filter(Boolean).at(-1)}</strong> · </>}
          {t(approval.state === "pending" ? "repositories.claudeApprovalPending" : "repositories.claudeApprovalRejected", { command: approval.command })}
        </p>
      ))}
      {state && !connected && <>
        <p className="meta-txt dense">{t("repositories.connectionLocalFiles")}</p>
        <p className="meta-txt dense">{t("repositories.connectionFiles")}</p>
        {clash && <p className="meta-txt dense cli-warn repo-agent-clash">{clash}</p>}
        <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
          <button type="button" className="btn btn-secondary repo-agent-connect-local" disabled={busy} onClick={() => connect.mutate("local")}>
            {working("local") ? t("repositories.connectionWorking") : t("repositories.connectionActionLocal")}
          </button>
          <button type="button" className="btn btn-ghost repo-agent-connect" disabled={busy} onClick={() => connect.mutate("team")}>
            {working("team") ? t("repositories.connectionWorking") : state === "pending" ? t("repositories.connectionRetry") : t("repositories.connectionAction")}
          </button>
        </div>
      </>}
      {connected && view?.local && <button type="button" className="btn btn-ghost repo-agent-connect" disabled={busy} onClick={() => connect.mutate("team")}>
        {working("team") ? t("repositories.connectionWorking") : t("repositories.connectionAlsoTeam")}
      </button>}
      <button type="button" className="btn btn-ghost" disabled={connection.isFetching} onClick={() => void connection.refetch()}>{t("repositories.connectionRefresh")}</button>
      {connection.error && <p role="alert" className="meta-txt">{readableError(connection.error)}</p>}
      {connect.error && <p role="alert" className="meta-txt">{readableError(connect.error)}</p>}
      {agents.length > 0 && <p className="meta-txt dense">{t("repositories.connectionChoose")}</p>}
      {agents.map((agent) => <p className="meta-txt dense repo-agent-capability" key={agent.id} data-agent={agent.id} data-chosen={agent.chosen}>
        <label style={{ cursor: "pointer" }}>
          <input type="checkbox" className="repo-agent-choose" checked={agent.chosen} disabled={choose.isPending || (agent.chosen && chosen.length === 1)}
            onChange={() => choose.mutate(agent.chosen ? chosen.filter((id) => id !== agent.id) : [...chosen, agent.id])} />{" "}
          <strong>{agent.title}</strong>
        </label> · {t(agent.tools ? "repositories.agentTools" : agent.instructions ? "repositories.agentInstructions" : "repositories.agentNotConfigured")} · {t(agent.tracking === "hooks" ? "repositories.agentHooks" : "repositories.agentNoTracking")}
        {agent.reviewHooks && agent.tracking === "hooks" && <> · {t("repositories.agentReviewHooks")}</>}
        {agent.chosen && agent.lastEventAt && <> · <span className="repo-agent-heard">{t("repositories.agentHeard", { time: agoLabel(agent.lastEventAt) })}</span></>}
        {silent.includes(agent) && <> · {t("repositories.agentNotHeard")}</>}
      </p>)}
      {silent.length > 0 && <p className="meta-txt dense cli-warn repo-agent-silent">
        {t("repositories.agentNotHeardHint", { agents: silent.map((agent) => agent.title).join(", ") })}
        {silent.some((agent) => agent.id === "codex") && <> {t("repositories.agentNotHeardCodex")}</>}
      </p>}
      {choose.error && <p role="alert" className="meta-txt">{readableError(choose.error)}</p>}
      {connect.data?.skipped.map((skip) => <p className="meta-txt dense cli-warn repo-agent-skipped" key={skip.agent} data-agent={skip.agent} data-reason={skip.reason}>
        {skip.reason === "no-connector" ? skip.message : t(SKIPPED_KEY[skip.reason], { agent: agents.find((agent) => agent.id === skip.agent)?.title ?? skip.agent, file: skip.file })}
      </p>)}
      {connect.data && <p role="status" className="meta-txt repo-agent-result">{connect.data.message}</p>}
      {url && <button type="button" className="btn btn-ghost repo-agent-pr" onClick={() => openExternal(url)}>{t("repositories.connectionPr")}</button>}
    </div>
  );
}
