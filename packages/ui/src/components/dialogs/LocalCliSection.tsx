import { useEffect, useState } from "react";
import type { CliCheck, EngineView, LocalCliStatus } from "@tomradex/agent";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { cliDiagnostics, engineStatus, useRecheckEngines } from "~/lib/localCli";
import { openExternal, pickProgram } from "~/lib/shell";
import { useToast } from "~/lib/toast";

/**
 * Inside a local agent's engine row: which CLI it runs and where that came
 * from, a path the person can choose instead, and — while it is not ready —
 * the steps that make it so on this platform.
 */
export function LocalCliSection({ engine, cli, command, onSaveCommand }: { engine: EngineView; cli: LocalCliStatus; command: string; onSaveCommand: (value: string) => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const recheck = useRecheckEngines();
  const about = useQuery({ queryKey: ["about"], queryFn: () => invoke("shell.about"), staleTime: Infinity, retry: false });
  const agent = engine.setup;
  const status = engineStatus(engine);
  const windows = cli.platform === "win32";

  const [draft, setDraft] = useState(command);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CliCheck | null>(null);
  useEffect(() => setDraft(command), [command]);

  const checkAndSave = async (file: string) => {
    if (!file.trim()) return;
    setChecking(true);
    setResult(null);
    try {
      const check = await invoke("agent.checkCli", engine.id, file.trim());
      setResult(check);
      if (check.ok) {
        setDraft(check.path);
        onSaveCommand(check.path);
      }
    } catch (error) {
      setResult({ ok: false, path: file, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setChecking(false);
    }
  };
  const browse = async () => {
    const file = await pickProgram(t("localCli.browseTitle", { name: cli.name }));
    if (file) {
      setDraft(file);
      await checkAndSave(file);
    }
  };
  const copyDiagnostics = () =>
    void navigator.clipboard
      ?.writeText(cliDiagnostics(engine, cli, about.data?.version))
      .then(() => toast({ body: t("localCli.diagnosticsCopied") }));

  const code = (text: string) => <code>{text}</code>;
  const steps =
    status === "sign-in"
      ? ["signIn", "recheck"]
      : status === "broken"
        ? ["verify", "recheck", "locate"]
        : status === "ready" || status === "service" || status === "other"
          ? []
          : ["install", "signIn", "verify", "recheck", "locate"];
  const install = agent?.install ?? [];

  return (
    <div className="cli-setup stack-3" data-testid={`cli-setup-${engine.id}`}>
      <div className="cli-state meta-txt" data-state={cli.state}>
        {cli.state === "ready" && cli.path && (
          <p>
            {tx("localCli.using", { path: <span className="mono">{cli.path}</span> })} · {t(cli.source === "manual" ? "localCli.sourceManual" : "localCli.sourceAuto")}
            {cli.version ? ` · ${cli.version}` : ""}
          </p>
        )}
        {status === "sign-in" && <p>{t("localCli.signInDetail", { title: engine.title })}</p>}
        {status === "missing" && <p>{t("localCli.missingDetail", { name: cli.name })}</p>}
        {status === "wsl" && <p className="cli-warn">{t("localCli.wslDetail", { name: cli.name, path: cli.wsl ?? "" })}</p>}
        {status === "broken" && (
          <p className="cli-warn">
            {tx("localCli.brokenDetail", { path: <span className="mono">{cli.path ?? ""}</span>, error: sentence(cli.error ?? engine.reason ?? "") })} {t("localCli.brokenHint")}
          </p>
        )}
        {cli.manual && (
          <p className="cli-warn">
            {tx(cli.state === "ready" ? "localCli.manualFallback" : "localCli.manualFailed", { path: <span className="mono">{cli.manual.path}</span>, error: cli.manual.error })}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor={`cliPath-${engine.id}`}>{t("localCli.pathLabel")}</label>
        <div className="row cli-path-row">
          <input
            id={`cliPath-${engine.id}`}
            className="input num"
            value={draft}
            placeholder={t("localCli.pathPlaceholder")}
            spellCheck={false}
            disabled={checking}
            onChange={(e) => {
              setDraft(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void checkAndSave(draft)}
          />
          <button type="button" className="btn btn-secondary" disabled={checking} onClick={() => void browse()}>
            {t("localCli.browse")}
          </button>
          <button type="button" className="btn btn-secondary" disabled={checking || !draft.trim() || draft.trim() === command} onClick={() => void checkAndSave(draft)}>
            {checking ? t("localCli.checking") : t("localCli.checkSave")}
          </button>
        </div>
        {result && (
          <span className={result.ok ? "meta-txt" : "meta-txt cli-warn"} role={result.ok ? undefined : "alert"} data-testid="cli-check-result">
            {result.ok ? t("localCli.checkOk", { version: result.version ?? "" }) : t("localCli.checkFailed", { error: result.error ?? "" })}
          </span>
        )}
        <span className="meta-txt">
          {t(windows ? "localCli.pathHelpWindows" : "localCli.pathHelp")}
          {command && (
            <>
              {" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setResult(null);
                  onSaveCommand("");
                }}
              >
                {t("localCli.resetAuto")}
              </button>
            </>
          )}
        </span>
      </div>

      {steps.length > 0 && agent && (
        <div className="cli-guide">
          <p className="cli-guide-head">{t("localCli.guideTitle", { title: engine.title })}</p>
          <ol>
            {steps.map((step) => (
              <li key={step}>
                {step === "install" && (
                  <>
                    {tx("localCli.stepInstall", { command: code(install[0]) })}
                    {install[1] && <> {tx("localCli.stepInstallOr", { command: code(install[1]) })}</>}
                    {agent.docs && (
                      <>
                        {" · "}
                        <button type="button" className="link-btn" onClick={() => openExternal(agent.docs!)}>
                          {t("localCli.docs")}
                        </button>
                      </>
                    )}
                  </>
                )}
                {step === "signIn" && agent.signIn && tx(agent.signInRuns ? "localCli.stepSignInRun" : "localCli.stepSignIn", { command: code(agent.signIn) })}
                {step === "verify" && tx("localCli.stepVerify", { command: code(`${cli.name} --version`) })}
                {step === "recheck" && t("localCli.stepRecheck")}
                {step === "locate" && tx("localCli.stepLocate", { command: code(`${windows ? "where" : "which"} ${cli.name}`) })}
              </li>
            ))}
          </ol>
          {windows && (
            <ul className="cli-notes">
              <li>{t("localCli.windowsWsl")}</li>
              {engine.id === "claude-code" && <li>{t("localCli.windowsGit")}</li>}
            </ul>
          )}
        </div>
      )}

      <div className="row cli-actions">
        <button type="button" className="btn btn-secondary" disabled={recheck.isPending} data-testid="cli-recheck" onClick={() => recheck.mutate()}>
          <Icon name="i-sync" size={12} /> {recheck.isPending ? t("localCli.rechecking") : t("localCli.recheck")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={copyDiagnostics}>
          <Icon name="i-copy" size={12} /> {t("localCli.copyDiagnostics")}
        </button>
      </div>
    </div>
  );
}

/** An error read out before another sentence needs its own full stop. */
const sentence = (text: string) => (!text || /[.!?。！？]$/.test(text) ? text : `${text}.`);
