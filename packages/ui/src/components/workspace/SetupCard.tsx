import { useEffect, useRef } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useEngines } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { LOCAL_AGENTS, engineStatus, useRecheckEngines } from "~/lib/localCli";
import { useSeen } from "~/lib/onboarding";
import { useSettings } from "~/lib/queries";

/**
 * What the assistant can do on this machine and what is still missing. Tomrade
 * needs both a model for the built-in engine and a local agent for Start, so
 * the card cannot be put away while either is missing.
 */
export function SetupCard({ onOpenSettings }: { onOpenSettings: (engineId?: string) => void }) {
  const { t, tx } = useI18n();
  const { seen } = useSeen();
  const engines = useEngines();
  const recheck = useRecheckEngines();
  const settings = useSettings();
  // A model saved in Settings is the most likely fix; look again as soon as it lands.
  const refetch = engines.refetch;
  useEffect(() => {
    void refetch();
  }, [settings.data, refetch]);
  // Back from a terminal where a CLI was just installed or signed in to: look again, past the probe cache,
  // at most every few seconds and only while a local agent is still missing.
  const missingLocal = useRef(false);
  const lastLook = useRef(0);
  const look = recheck.mutate;
  useEffect(() => {
    const onFocus = () => {
      if (!missingLocal.current || Date.now() - lastLook.current < 5000) return;
      lastLook.current = Date.now();
      look();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [look]);

  const all = engines.data;
  if (!all) return null;
  const noneReady = !all.some((e) => e.ok);
  const model = all.find((e) => e.id === "loop");
  const locals = all.filter((e) => e.id in LOCAL_AGENTS);
  const localReady = locals.filter((e) => e.ok);
  missingLocal.current = locals.length > 0 && localReady.length === 0;
  if ((!model || model.ok) && (!locals.length || localReady.length)) return null;
  // Never marked: only a check's "*" puts it away, and never with nothing ready.
  if (!noneReady && seen("setup-required")) return null;

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
      <p className="setup-head">{noneReady ? t("agentPanel.giveABrain") : t("onboarding.setupTitle")}</p>
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
                  {locals.filter((e) => LOCAL_AGENTS[e.id].suggested || engineStatus(e) !== "missing").map((e) => (
                    <span key={e.id} className="setup-fix">
                      {fix(e)}
                    </span>
                  ))}
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-secondary setup-action" data-testid="setup-local" onClick={() => onOpenSettings(locals[0].id)}>
                      {t("localCli.setUpLocal")}
                    </button>
                    {/* installed or signed in a moment ago: look again now, past the probe cache */}
                    <button type="button" className="btn btn-ghost setup-action" data-testid="setup-recheck" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
                      <Icon name="i-sync" size={12} /> {recheck.isPending ? t("localCli.rechecking") : t("localCli.recheck")}
                    </button>
                  </span>
                </>
              )}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
