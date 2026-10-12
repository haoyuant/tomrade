import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { useProjects, useSettings } from "~/lib/queries";
import { isLocalAgent, useSetup } from "~/lib/setup";
import { DetectedModels } from "./DetectedModels";
import { LocalAgentSetup } from "./LocalAgentSetup";
import { QuickModelSetup } from "./QuickModelSetup";

/**
 * First run, before the projects: connect a model or a local agent — either
 * is enough. What is already on this computer is offered first. Once it
 * works, the screen says what that unlocked and steps aside.
 */
export function FirstRunSetup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { engines, state } = useSetup();
  const projects = useProjects();
  const preferred = (useSettings().data?.agent as { defaultEngine?: string } | undefined)?.defaultEngine;
  const [settings, setSettings] = useState<{ engine?: string } | null>(null);
  const names = (list: { title: string }[]) => list.map((e) => e.title).join(" · ");
  // The engine the panel will open threads on: the chosen default when it can run, else the first that can.
  const assistant = state ? (state.assistant.find((e) => e.id === preferred) ?? state.assistant[0]) : undefined;
  const sample = projects.data?.find((p) => p.sample);

  return (
    <div className="app first-run" data-testid="first-run-setup">
      <header className="titlebar">
        <span className="crumb-title">Tomrade</span>
        <Spacer />
      </header>
      <main className="sheet">
        <div className="wrap stack-4" style={{ maxWidth: 680 }}>
          <div>
            <Eyebrow>{t("setup.eyebrow")}</Eyebrow>
            <h1 className="sec-title" style={{ marginTop: "var(--space-3)" }}>
              {state?.complete ? t("setup.doneTitle") : t("setup.title")}
            </h1>
            {!state?.complete && <p className="sec-lede" style={{ marginTop: "var(--space-2)" }}>{t("setup.lede")}</p>}
          </div>

          {state?.complete ? (
            <div className="panel stack-3" data-testid="setup-done">
              <ul className="setup-rows">
                <li className="setup-row is-ok">
                  <Icon name="i-check" size={13} />
                  <span>{t("setup.doneAssistant", { names: assistant?.title ?? "" })}</span>
                </li>
                {state.locals.length > 0 && (
                  <li className="setup-row is-ok">
                    <Icon name="i-check" size={13} />
                    <span>{t("setup.doneStart", { names: names(state.locals) })}</span>
                  </li>
                )}
                {state.worker.title && (
                  <li className="setup-row is-ok">
                    <Icon name="i-check" size={13} />
                    <span>{t("setup.donePlanning", { name: state.worker.title })}</span>
                  </li>
                )}
              </ul>
              {sample ? (
                <>
                  <p className="meta-txt">{t("setup.doneTour")}</p>
                  <div className="row" style={{ gap: "var(--space-2)" }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="setup-open-tour"
                      onClick={() => {
                        onDone();
                        void navigate({ to: "/p/$projectId", params: { projectId: sample.id } });
                      }}
                    >
                      {t("setup.openTour")}
                    </button>
                    <button type="button" className="btn btn-secondary" data-testid="setup-continue" onClick={onDone}>
                      {t("setup.toProjects")}
                    </button>
                  </div>
                </>
              ) : (
                <div>
                  <button type="button" className="btn btn-primary" data-testid="setup-continue" onClick={onDone}>
                    {t("setup.continue")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <DetectedModels />
              <section className="panel stack-3">
                <h2 className="setup-section-title">{t("setup.keyTitle")}</h2>
                <p className="meta-txt">{t("setup.keyLede")}</p>
                <QuickModelSetup />
              </section>
              {engines && engines.some((e) => e.setup && isLocalAgent(e)) && (
                <section className="panel stack-3">
                  <h2 className="setup-section-title">{t("setup.cliTitle")}</h2>
                  <p className="meta-txt">{t("setup.cliLede")}</p>
                  <LocalAgentSetup engines={engines} onOpenSettings={(engine) => setSettings({ engine })} />
                </section>
              )}
              <div className="row" style={{ gap: "var(--space-3)", alignItems: "center" }}>
                <button type="button" className="btn btn-ghost" data-testid="setup-later" onClick={onDone}>
                  {t("setup.later")}
                </button>
                <span className="meta-txt">{t("setup.laterNote")}</span>
              </div>
            </>
          )}
        </div>
      </main>
      <SettingsDialog open={!!settings} onOpenChange={(open) => !open && setSettings(null)} pane="assistant" engine={settings?.engine} />
    </div>
  );
}
