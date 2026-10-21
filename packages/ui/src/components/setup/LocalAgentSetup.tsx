import { useEffect, useRef, useState } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { engineHealth, engineProblem } from "~/lib/engines";
import { engineStateLabel, engineStatus, useRecheckEngines } from "~/lib/localCli";
import { setupRows, useSetupInTerminal } from "~/lib/setup";
import { openExternal } from "~/lib/shell";
import { useToast } from "~/lib/toast";

function CommandLine({ command }: { command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <span className="setup-command">
      <code>{command}</code>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        <Icon name="i-copy" size={11} /> {copied ? t("setup.copied") : t("setup.copy")}
      </button>
    </span>
  );
}

/**
 * Local agents the engines declare how to set up: each one's state, and the
 * install or sign-in it still needs as a command to copy or run in a terminal.
 * Coming back to the window looks again, past the probe cache.
 */
export function LocalAgentSetup({ engines, onOpenSettings }: { engines: EngineView[]; onOpenSettings: (engineId?: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const recheck = useRecheckEngines();
  const terminal = useSetupInTerminal();
  const rows = setupRows(engines);
  const waiting = rows.some((e) => engineHealth(e) !== "works");

  const lastLook = useRef(0);
  const look = recheck.mutate;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  useEffect(() => {
    const onFocus = () => {
      if (!waitingRef.current || Date.now() - lastLook.current < 5000) return;
      lastLook.current = Date.now();
      look();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [look]);

  // Without the terminal (code link off, or no terminal app), the command is handed over instead.
  const run = (engine: EngineView, step: "install" | "signIn") => {
    const command = (step === "install" ? engine.setup?.install[0] : engine.setup?.signIn) ?? "";
    terminal.mutate({ engineId: engine.id, step }, {
      onSuccess: ({ launched }) => toast({ body: launched ? t("setup.terminalOpened") : t("setup.terminalNotOpened", { command }) }),
      onError: () => toast({ body: t("setup.terminalNotOpened", { command }) })
    });
  };

  return (
    <ul className="setup-rows" data-testid="local-agents">
      {rows.map((e) => {
        const status = engineStatus(e);
        const setup = e.setup!;
        const installing = status === "missing" || status === "desktop-only";
        // "Only the desktop app" already says the app lacks the CLI.
        const desktopNote = status === "missing" && setup.desktop;
        const download = installing && (setup.download || desktopNote) && (
          <span className="setup-fix">
            {desktopNote && t(desktopNote.shipsCli ? "localCli.desktopShipsCli" : "localCli.desktopNoCli", { app: desktopNote.title, name: e.cli?.name ?? "" })}
            {setup.download && (
              <button type="button" className="link-btn setup-action" data-testid={`download-${e.id}`} onClick={() => openExternal(setup.download!)}>
                {t("localCli.download")} →
              </button>
            )}
          </span>
        );
        // A desktop app that brings the CLI is the easier way in, so it comes first.
        const downloadFirst = Boolean(setup.desktop?.shipsCli);
        // Found and signed in, but not yet shown to run: say so, and what its agent said.
        const health = engineHealth(e);
        const problem = engineProblem(e);
        const label = e.ok && health === "checking" ? t("localCli.stateChecking") : e.ok && health === "broken" ? t("localCli.stateNotRunning") : engineStateLabel(e, t, t("settingsDialog.engineUnavailable"));
        return (
          <li key={e.id} className={health === "works" ? "setup-row is-ok" : "setup-row"} data-engine={e.id} data-health={health}>
            <Icon name={health === "works" ? "i-check" : health === "checking" ? "i-sync" : "i-warn"} size={13} />
            <div>
              <span className="setup-name">
                {e.title} <span className="meta-txt">· {label}</span>
              </span>
              {problem && (
                <span className="setup-fix" data-testid={`problem-${e.id}`}>
                  {t(problem.kind === "models" ? "setup.problemModels" : "setup.problemTried", { detail: problem.detail })}
                </span>
              )}
              {status === "desktop-only" && <span className="setup-fix">{t("localCli.desktopOnlyDetail", { app: e.cli?.desktopApp ?? "", name: e.cli?.name ?? "" })}</span>}
              {downloadFirst && download}
              {installing && !setup.install[0] && setup.docs && (
                <span className="setup-fix">
                  {t("setup.noInstaller")}
                  <button type="button" className="link-btn setup-action" data-testid={`install-guide-${e.id}`} onClick={() => openExternal(setup.docs!)}>
                    {t("localCli.docs")} →
                  </button>
                </span>
              )}
              {installing && setup.install[0] && (
                <span className="setup-fix">
                  <CommandLine command={setup.install[0]} />
                  <button type="button" className="btn btn-secondary btn-xs setup-action" data-testid={`install-${e.id}`} disabled={terminal.isPending} onClick={() => run(e, "install")}>
                    {t("setup.installInTerminal")}
                  </button>
                </span>
              )}
              {!downloadFirst && download}
              {status === "sign-in" && setup.signIn && (
                <span className="setup-fix">
                  <CommandLine command={setup.signIn} />
                  <button type="button" className="btn btn-secondary btn-xs setup-action" data-testid={`signin-${e.id}`} disabled={terminal.isPending} onClick={() => run(e, "signIn")}>
                    {t("setup.signInInTerminal")}
                  </button>
                </span>
              )}
              {((!e.ok && !installing && status !== "sign-in") || problem) && (
                <button type="button" className="link-btn setup-fix" onClick={() => onOpenSettings(e.id)}>
                  {t("localCli.configure")} →
                </button>
              )}
            </div>
          </li>
        );
      })}
      {waiting && (
        <li>
          <button type="button" className="btn btn-ghost btn-xs" data-testid="setup-recheck" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
            <Icon name="i-sync" size={12} /> {recheck.isPending ? t("localCli.rechecking") : t("localCli.recheck")}
          </button>
        </li>
      )}
    </ul>
  );
}
