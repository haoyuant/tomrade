import { useEffect } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useEngines } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { useSeen } from "~/lib/onboarding";
import { useSettings } from "~/lib/queries";

/** The local agents Start can hand a ticket to, and what fixes each one in a terminal. */
const LOCAL: Record<string, { install: string; signIn: string }> = {
  "claude-code": { install: "npm install -g @anthropic-ai/claude-code", signIn: "claude" },
  codex: { install: "npm install -g @openai/codex", signIn: "codex login" },
  pi: { install: "npm install -g @earendil-works/pi-coding-agent", signIn: "pi" }
};

/**
 * What the assistant can do on this machine and what is still missing: a
 * model for the built-in engine, a local agent for Start. With nothing ready
 * it is the panel's only way forward and stays; otherwise it can be put away.
 */
export function SetupCard({ onOpenSettings }: { onOpenSettings: () => void }) {
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
  const locals = all.filter((e) => e.id in LOCAL);
  const localReady = locals.filter((e) => e.ok);
  if ((!model || model.ok) && (!locals.length || localReady.length)) return null;
  if (!noneReady && seen("setup-card")) return null;

  const fix = (e: EngineView) => {
    const commands = LOCAL[e.id];
    if (e.need === "install") return tx("onboarding.installLine", { title: e.title, command: <code>{commands.install}</code> });
    if (e.need === "sign-in") return tx("onboarding.signInLine", { title: e.title, command: <code>{commands.signIn}</code> });
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
                <button type="button" className="btn btn-secondary setup-action" onClick={onOpenSettings}>
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
                locals.map((e) => (
                  <span key={e.id} className="setup-fix">
                    {fix(e)}
                  </span>
                ))
              )}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
