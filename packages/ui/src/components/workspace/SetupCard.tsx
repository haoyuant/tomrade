import { DetectedModels } from "~/components/setup/DetectedModels";
import { LocalAgentSetup } from "~/components/setup/LocalAgentSetup";
import { QuickModelSetup } from "~/components/setup/QuickModelSetup";
import { useI18n } from "~/lib/i18n";
import { useSeen } from "~/lib/onboarding";
import { setupRows, useSetup } from "~/lib/setup";

/**
 * Until Tomrade can work: connect a model or a local agent, either one. A
 * model also runs the built-in agent and a signed-in agent also plans, so the
 * card goes away after the first that works — and cannot be put away before.
 */
export function SetupCard({ onOpenSettings }: { onOpenSettings: (engineId?: string) => void }) {
  const { t } = useI18n();
  const { seen } = useSeen();
  const { engines, state } = useSetup();
  if (!engines || !state || state.complete) return null;
  const noneReady = !engines.some((e) => e.ok);
  // Never marked: only a check's "*" puts it away, and never with nothing ready.
  if (!noneReady && seen("setup-required")) return null;

  return (
    <div className={noneReady ? "agent-empty agent-setup" : "agent-setup"} data-testid="setup-card">
      <p className="setup-head">{t("setup.cardTitle")}</p>
      <DetectedModels />
      <QuickModelSetup />
      {setupRows(engines).length > 0 && (
        <div className="stack-2">
          <p className="setup-name">{t("setup.cliTitle")}</p>
          <LocalAgentSetup engines={engines} onOpenSettings={onOpenSettings} />
        </div>
      )}
      <button type="button" className="link-btn meta-txt" onClick={() => onOpenSettings()}>
        {t("setup.cardMore")} →
      </button>
    </div>
  );
}
