import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useCancelGitInstall, useGitStatus, useInstallGit } from "~/lib/machineSetup";
import { openExternal } from "~/lib/shell";

const DOWNLOAD = "https://git-scm.com/downloads";

/**
 * A quiet row when the machine has no working git: Tomrade runs without it,
 * but this says what needs it, and installs it with the system's own
 * mechanism where there is one. Nothing shows while git answers.
 */
export function GitNotice() {
  const { t } = useI18n();
  const git = useGitStatus();
  const install = useInstallGit();
  const cancel = useCancelGitInstall();
  const status = git.data;
  if (!status || status.state === "ready") return null;
  const progress = status.install;
  const busy = progress?.phase === "running" || progress?.phase === "waiting";
  return (
    <ul className="setup-rows" data-testid="git-notice">
      <li className="setup-row" data-state={status.state}>
        <Icon name={busy ? "i-sync" : "i-warn"} size={13} />
        <div>
          <span className="setup-name">{t("setup.gitTitle")}</span>
          <span className="setup-fix">{status.state === "broken" ? t("setup.gitBroken", { error: status.error ?? "" }) : t("setup.gitMissing")}</span>
          {busy && (
            <span className="setup-fix" data-testid="git-installing">
              {t(progress?.phase === "waiting" ? "setup.gitWaiting" : "setup.gitInstalling")}
              <button type="button" className="link-btn setup-action" onClick={() => cancel.mutate()}>
                {t("common.cancel")}
              </button>
            </span>
          )}
          {progress?.phase === "failed" && progress.kind !== "cancelled" && (
            <span className="setup-fix" role="alert" data-testid="git-install-failed">
              {progress.kind === "timeout" ? t("setup.gitInstallTimeout") : t("setup.gitInstallFailed", { error: progress.message ?? "" })}
              {progress.output && (
                <details className="eng-try-details">
                  <summary>{t("setup.gitInstallOutput")}</summary>
                  <pre>{progress.output}</pre>
                </details>
              )}
            </span>
          )}
          {!busy && (
            <span className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
              {status.installer && status.state === "missing" && (
                <button type="button" className="btn btn-secondary btn-xs" data-testid="git-install" disabled={install.isPending} onClick={() => install.mutate()}>
                  {t("setup.gitInstall")}
                </button>
              )}
              <button type="button" className="link-btn" data-testid="git-download" onClick={() => openExternal(DOWNLOAD)}>
                {t("setup.gitDownload")} →
              </button>
            </span>
          )}
        </div>
      </li>
    </ul>
  );
}
