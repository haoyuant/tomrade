import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SettingsDialog } from "~/components/onDemand";
import { GlobalHotkeyField } from "~/components/dialogs/settings/GlobalHotkeyField";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer, Tag } from "~/components/ui/atoms";
import { invoke, logQuietly } from "~/lib/api";
import { keyLabel } from "~/lib/keybindings";
import { errorSpec, readableError, useToast } from "~/lib/toast";
import { useI18n } from "~/lib/i18n";
import { useCommands, useProjects, useSaveSettings, useSettings } from "~/lib/queries";
import { findEngine } from "~/lib/agent";
import { useSetup } from "~/lib/setup";
import { builtinProblem } from "~/lib/setupState";
import { RepoTask } from "./RepoTask";
import { SetupOptions } from "./SetupOptions";

/**
 * First run, before the projects: connect a model or a local agent — either
 * is enough. What is already on this computer is offered first. Once it
 * works, the screen says what that unlocked and offers two ways on: a small
 * thing in the person's own repository, or the sample project's tour.
 */
export function FirstRunSetup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { engines, state } = useSetup({ autoTry: true });
  const projects = useProjects();
  const preferred = (useSettings().data?.agent as { defaultEngine?: string } | undefined)?.defaultEngine;
  const [settings, setSettings] = useState<{ engine?: string } | null>(null);
  const names = (list: { title: string }[]) => list.map((e) => e.title).join(" · ");
  // The engine the panel will open threads on: the chosen default when it can run, else the first that can.
  const assistant = state ? (findEngine(state.assistant, preferred) ?? state.assistant[0]) : undefined;
  const sample = projects.data?.find((p) => p.sample);
  const own = state?.locals.filter((e) => !e.usesModels) ?? [];
  // Chat works on a model the built-in agent cannot drive; tickets then have nowhere to go, and setup says why.
  const cannot = state && engines && !state.route ? builtinProblem(engines, state.worker) : null;
  const toast = useToast();
  // Picked here to work in the Terminal window: it opens once setup steps aside, not over it.
  const [cli, setCli] = useState(false);
  const done = () => {
    onDone();
    if (cli)
      void invoke("contributions.run", "code-sessions.open", {}).catch((error: unknown) =>
        toast({ ...errorSpec(error), body: t("setup.terminalWindowFailed", { reason: readableError(error), key: keyLabel("palette") }) })
      );
  };
  // One of the two ways on once set, and where "later" goes.
  const openTour = () => {
    done();
    if (sample) void navigate({ to: "/p/$projectId", params: { projectId: sample.id } });
  };
  // Once opened, the steps stay mounted while hidden, so going back and in again goes on with the project already made.
  const [repoTask, setRepoTask] = useState<"open" | "hidden" | null>(null);
  // The small thing was sent: its project opens on the assistant's answer.
  const openProject = (projectId: string) => {
    done();
    void navigate({ to: "/p/$projectId", params: { projectId } });
  };
  // A chain that keeps failing hands over to the troubleshooter, whose thread lives in the sample project; the panel shows the newest thread.
  const troubleshoot =
    sample && engines?.some((e) => e.id === "doctor")
      ? (engineId: string, error?: string) =>
          void invoke("doctor.start", sample.id, { engineId, ...(error ? { error } : {}) }).then(() => {
            onDone();
            void navigate({ to: "/p/$projectId", params: { projectId: sample.id } });
          }, logQuietly("doctor.start"))
      : undefined;

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
                {assistant?.tried?.reply && (
                  <li className="setup-row is-ok" data-testid="setup-done-reply">
                    <Icon name="i-check" size={13} />
                    <span>{t("setup.doneReply", { reply: assistant.tried.reply })}</span>
                  </li>
                )}
                {state.locals.length > 0 && (
                  <li className="setup-row is-ok">
                    <Icon name="i-check" size={13} />
                    <span>{t("setup.doneStart", { names: names(state.locals) })}</span>
                  </li>
                )}
                {state.route && (
                  <li className="setup-row is-ok" data-testid="setup-route" data-route={state.route}>
                    <Icon name="i-check" size={13} />
                    <span>{state.route === "builtin" ? t("setup.doneRouteBuiltin", { model: state.worker.title ?? "" }) : t(state.route === "managed" ? "setup.doneRouteManaged" : "setup.doneRouteOwn", { names: names(own) })}</span>
                  </li>
                )}
                {cannot && (
                  <li className="setup-row" data-testid="setup-builtin-cannot">
                    <Icon name="i-warn" size={13} />
                    <span>{t("setup.builtinCannot", { reason: cannot })}</span>
                  </li>
                )}
                {state.worker.title && (
                  <li className="setup-row is-ok">
                    <Icon name="i-check" size={13} />
                    <span>{t("setup.donePlanning", { name: state.worker.title })}</span>
                  </li>
                )}
              </ul>
              {state.locals.length > 0 && <WorkStyle onPick={(style) => setCli(style === "cli")} />}
              {repoTask && (
                <div hidden={repoTask === "hidden"}>
                  <RepoTask agents={state.locals.length > 0 ? names(state.locals) : null} onBack={() => setRepoTask("hidden")} onOpened={openProject} />
                </div>
              )}
              {repoTask !== "open" && (
                <div className="stack-3" data-testid="setup-paths">
                  <p className="meta-txt">{t("firstTask.pathsTitle")}</p>
                  <div className="setup-path" data-testid="setup-path-repo">
                    <span className="setup-name">
                      {t("firstTask.repoTitle")} <Tag tone="strong">{t("firstTask.recommended")}</Tag>
                    </span>
                    <span className="meta-txt">{t("firstTask.repoDesc")}</span>
                    <div>
                      <button type="button" className="btn btn-primary" data-testid="setup-repo-task" onClick={() => setRepoTask("open")}>
                        {t("firstTask.repoBegin")}
                      </button>
                    </div>
                  </div>
                  {sample && (
                    <div className="setup-path" data-testid="setup-path-tour">
                      <span className="setup-name">{t("firstTask.tourTitle")}</span>
                      <span className="meta-txt">{t("setup.doneTour")}</span>
                      <div>
                        <button type="button" className="btn btn-secondary" data-testid="setup-open-tour" onClick={openTour}>
                          {t("setup.openTour")}
                        </button>
                      </div>
                    </div>
                  )}
                  <div>
                    <button type="button" className="btn btn-ghost" data-testid="setup-continue" onClick={done}>
                      {t(sample ? "setup.toProjects" : "setup.continue")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <SetupOptions
                engines={engines}
                onOpenSettings={(engine) => setSettings({ engine })}
                onTroubleshoot={troubleshoot}
                frame={(part) => (
                  <section className="panel stack-3">
                    <h2 className="setup-section-title">{part.title}</h2>
                    <p className="meta-txt">{part.lede}</p>
                    {part.body}
                  </section>
                )}
              />
              <div className="row" style={{ gap: "var(--space-3)", alignItems: "center" }}>
                <button type="button" className="btn btn-ghost" data-testid="setup-later" onClick={openTour}>
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

/**
 * Asked once, where a local agent is set up: someone who works in several CLIs at once starts on the Terminal window.
 * It is Settings › Sessions' "When Tomrade opens", answered here so nobody has to find it.
 */
function WorkStyle({ onPick }: { onPick: (style: "panel" | "cli") => void }) {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings();
  const terminal = !!useCommands().data?.some((c) => c.id === "code-sessions.open");
  // the click shows at once; the saved value catches up
  const [picked, setPicked] = useState<"panel" | "cli" | null>(null);
  if (!terminal || !settings.data) return null;
  const current = picked ?? ((settings.data.sessions as { openAtStart?: string } | undefined)?.openAtStart === "terminal" ? "cli" : "panel");
  const pick = (style: "panel" | "cli") => {
    if (style === current) return;
    setPicked(style);
    // Only this field differs between two quick saves, so the later one stands either way.
    save.mutate({ ...settings.data!, sessions: { ...(settings.data!.sessions as object | undefined), openAtStart: style === "cli" ? "terminal" : "main" } });
    // Several CLIs at once: the Terminal window when setup is done, and a key to bring it up from any app.
    onPick(style);
  };
  return (
    <div className="stack-2" data-testid="setup-work-style">
      <p className="meta-txt">{t("setup.workStyleTitle")}</p>
      <div className="quick-providers" role="radiogroup" aria-label={t("setup.workStyleTitle")}>
        {(["cli", "panel"] as const).map((style) => (
          <button key={style} type="button" role="radio" aria-checked={style === current} className={style === current ? "chip-opt sel" : "chip-opt"} data-style={style} onClick={() => pick(style)}>
            {t(style === "cli" ? "setup.workStyleCli" : "setup.workStylePanel")}
          </button>
        ))}
      </div>
      <p className="meta-txt dense">{t(current === "cli" ? "setup.workStyleCliNote" : "setup.workStylePanelNote")}</p>
      {picked === "cli" && (
        <div className="stack-2" data-testid="setup-hotkey">
          <p className="meta-txt">{t("setup.workStyleHotkey")}</p>
          <GlobalHotkeyField />
        </div>
      )}
    </div>
  );
}
