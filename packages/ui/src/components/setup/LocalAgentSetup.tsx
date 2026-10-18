import { useEffect, useRef, useState } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
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
  const waiting = rows.some((e) => !e.ok);

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
        return (
          <li key={e.id} className={e.ok ? "setup-row is-ok" : "setup-row"} data-engine={e.id}>
            <Icon name={e.ok ? "i-check" : "i-warn"} size={13} />
            <div>
              <span className="setup-name">
                {e.title} <span className="meta-txt">· {engineStateLabel(e, t, t("settingsDialog.engineUnavailable"))}</span>
              </span>
              {status === "desktop-only" && <span className="setup-fix">{t("localCli.desktopOnlyDetail", { app: e.cli?.desktopApp ?? "", name: e.cli?.name ?? "" })}</span>}
              {(status === "missing" || status === "desktop-only") && !setup.install[0] && setup.docs && (
                <span className="setup-fix">
                  {t("setup.noInstaller")}
                  <button type="button" className="link-btn setup-action" data-testid={`install-guide-${e.id}`} onClick={() => openExternal(setup.docs!)}>
                    {t("localCli.docs")} →
                  </button>
                </span>
              )}
              {(status === "missing" || status === "desktop-only") && setup.install[0] && (
                <span className="setup-fix">
                  <CommandLine command={setup.install[0]} />
                  <button type="button" className="btn btn-secondary btn-xs setup-action" data-testid={`install-${e.id}`} disabled={terminal.isPending} onClick={() => run(e, "install")}>
                    {t("setup.installInTerminal")}
                  </button>
                </span>
              )}
              {status === "sign-in" && setup.signIn && (
                <span className="setup-fix">
                  <CommandLine command={setup.signIn} />
                  <button type="button" className="btn btn-secondary btn-xs setup-action" data-testid={`signin-${e.id}`} disabled={terminal.isPending} onClick={() => run(e, "signIn")}>
                    {t("setup.signInInTerminal")}
                  </button>
                </span>
              )}
              {!e.ok && status !== "missing" && status !== "desktop-only" && status !== "sign-in" && (
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
