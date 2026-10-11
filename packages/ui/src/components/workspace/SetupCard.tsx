import { useEffect } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useEngines } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { LOCAL_AGENTS, engineStatus } from "~/lib/localCli";
import { useSeen } from "~/lib/onboarding";
import { useSettings } from "~/lib/queries";

/**
 * What the assistant can do on this machine and what is still missing: a
 * model for the built-in engine, a local agent for Start. With nothing ready
 * it is the panel's only way forward and stays; otherwise it can be put away.
 */
export function SetupCard({ onOpenSettings }: { onOpenSettings: (engineId?: string) => void }) {
  const { t, tx } = useI18n();
  const { seen, markSeen } = useSeen();
  const engines = useEngines();
  const settings = useSettings();
  // A model saved in Settings is the most likely fix; look again as soon as it lands.
  const refetch = engines.refetch;
  useEffect(() => {
    void refetch();
  }, [settings.data, refetch]);

  const all = engines.data;
  if (!all) return null;
  const noneReady = !all.some((e) => e.ok);
  const model = all.find((e) => e.id === "loop");
  const locals = all.filter((e) => e.id in LOCAL_AGENTS);
  const localReady = locals.filter((e) => e.ok);
  if ((!model || model.ok) && (!locals.length || localReady.length)) return null;
  if (!noneReady && seen("setup-card")) return null;

  const fix = (e: EngineView) => {
    const agent = LOCAL_AGENTS[e.id];
    const status = engineStatus(e);
    if (status === "missing") return tx("onboarding.installLine", { title: e.title, command: <code>{agent.install(e.cli?.platform ?? "")[0]}</code> });
    if (status === "wsl") return t("localCli.wslLine", { title: e.title });
    if (status === "broken") return t("localCli.repairLine", { title: e.title });
    if (status === "sign-in") return tx("onboarding.signInLine", { title: e.title, command: <code>{agent.signIn}</code> });
    return t("agentPanel.engineReasonLine", { title: e.title, reason: e.reason ?? "" });
  };

  return (
    <div className={noneReady ? "agent-empty agent-setup" : "agent-setup"}>
      <div className="setup-head">
        <p>{noneReady ? t("agentPanel.giveABrain") : t("onboarding.setupTitle")}</p>
        {!noneReady && (
          <button type="button" className="btn btn-ghost setup-hide" title={t("onboarding.setupHideTitle")} onClick={() => markSeen("setup-card")}>
            {t("onboarding.setupHide")}
          </button>
        )}
      </div>
      <ul className="setup-rows">
        {model && (
          <li className={model.ok ? "setup-row is-ok" : "setup-row"} data-setup="model">
            <Icon name={model.ok ? "i-check" : "i-warn"} size={13} />
            <div>
              <span className="setup-name">{t("onboarding.modelName")}</span>
              <span className="setup-unlocks">{t("onboarding.modelUnlocks")}</span>
              {model.ok ? (
                <span className="setup-fix">{t("onboarding.ready")}</span>
              ) : (
                <button type="button" className="btn btn-secondary setup-action" onClick={() => onOpenSettings()}>
                  {t("agentPanel.connectModelApi")}
                </button>
              )}
            </div>
          </li>
        )}
        {!!locals.length && (
          <li className={localReady.length ? "setup-row is-ok" : "setup-row"} data-setup="local">
            <Icon name={localReady.length ? "i-check" : "i-warn"} size={13} />
            <div>
              <span className="setup-name">{t("onboarding.localName")}</span>
              <span className="setup-unlocks">{t("onboarding.localUnlocks")}</span>
              {localReady.length ? (
                <span className="setup-fix">{t("onboarding.readyWith", { names: localReady.map((e) => e.title).join(" · ") })}</span>
              ) : (
                <>
                  <span className="setup-fix">{t("localCli.whatIsLocal")}</span>
                  {locals.map((e) => (
                    <span key={e.id} className="setup-fix">
                      {fix(e)}
                    </span>
                  ))}
                  <button type="button" className="btn btn-secondary setup-action" data-testid="setup-local" onClick={() => onOpenSettings(locals[0].id)}>
                    {t("localCli.setUpLocal")}
                  </button>
                </>
              )}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
