import { SetupOptions } from "~/components/setup/SetupOptions";
import { useI18n } from "~/lib/i18n";
import { useSeen } from "~/lib/onboarding";
import { useSetup } from "~/lib/setup";

/**
 * Until Tomrade can work: connect a model or a local agent, either one. A
 * model also runs the built-in agent and a signed-in agent also plans, so the
 * card goes away after the first that works — and cannot be put away before.
 */
export function SetupCard({ onOpenSettings, onTroubleshoot }: { onOpenSettings: (engineId?: string) => void; onTroubleshoot?: (engineId: string, error?: string) => void }) {
  const { t } = useI18n();
  const { seen } = useSeen();
  const { engines, state } = useSetup({ autoTry: !seen("setup-required") });
  if (!engines || !state || state.complete) return null;
  const noneReady = !engines.some((e) => e.ok);
  // Never marked: only a check's "*" puts it away, and never with nothing ready.
  if (!noneReady && seen("setup-required")) return null;
  // An agent still answering its test message most likely works: no card until it has said.
  if (state.checking) return null;

  return (
    <div className={noneReady ? "agent-empty agent-setup" : "agent-setup"} data-testid="setup-card">
      <p className="setup-head">{t("setup.cardTitle")}</p>
      <SetupOptions
        engines={engines}
        onOpenSettings={onOpenSettings}
        onTroubleshoot={onTroubleshoot}
        frame={(part) =>
          part.id === "key" ? (
            part.body
          ) : (
            <div className="stack-2">
              <p className="setup-name">{part.title}</p>
              {part.body}
            </div>
          )
        }
      />
      <button type="button" className="link-btn meta-txt" onClick={() => onOpenSettings()}>
        {t("setup.cardMore")} →
      </button>
    </div>
  );
}
