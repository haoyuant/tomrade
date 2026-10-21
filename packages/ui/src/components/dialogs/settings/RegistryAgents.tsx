import { useState } from "react";
import { useI18n } from "~/lib/i18n";
import { useRegistryAgents, useRegistryChange } from "~/lib/acpRegistry";
import { Fold } from "~/components/ui/atoms";

/**
 * Agents from the ACP registry, added in one click: each becomes a local agent
 * run through npx, set up like any other row above. Entries Tomrade already
 * has are left out; the backend's cache answers offline.
 */
export function RegistryAgents() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const listing = useRegistryAgents(open);
  const { add, remove, refresh } = useRegistryChange();
  const busy = add.isPending || remove.isPending || refresh.isPending;
  return (
    <Fold id="acp-registry" title={t("settingsDialog.registryTitle")} open={open} onToggle={() => setOpen((o) => !o)}>
      <p className="meta-txt">{t("settingsDialog.registryNote")}</p>
      {listing.data?.state === "unavailable" && (
        <p className="meta-txt" role="alert" data-testid="registry-unavailable">
          {t("settingsDialog.registryUnavailable")}{" "}
          <button type="button" className="link-btn" disabled={busy} onClick={() => refresh.mutate()}>
            {t("settingsDialog.registryRetry")}
          </button>
        </p>
      )}
      {listing.data && listing.data.state !== "unavailable" && listing.data.agents.length === 0 && <p className="meta-txt">{t("settingsDialog.registryEmpty")}</p>}
      {(listing.data?.agents.length ?? 0) > 0 && (
        <ul className="setup-rows" data-testid="registry-agents">
          {listing.data!.agents.map((agent) => (
            <li key={agent.id} className="setup-row" data-agent={agent.id}>
              <div style={{ flex: 1 }}>
                <span className="setup-name">
                  {agent.name}
                  {agent.license && <span className="meta-txt"> · {agent.license}</span>}
                </span>
                {agent.description && <span className="setup-fix">{agent.description}</span>}
              </div>
              <button
                type="button"
                className={agent.added ? "btn btn-ghost btn-xs" : "btn btn-secondary btn-xs"}
                data-testid={`registry-${agent.added ? "remove" : "add"}-${agent.id}`}
                disabled={busy}
                onClick={() => (agent.added ? remove.mutate(agent.id) : add.mutate(agent.id))}
              >
                {t(agent.added ? "settingsDialog.registryRemove" : "settingsDialog.registryAdd")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Fold>
  );
}
