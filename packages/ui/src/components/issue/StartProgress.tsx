import type { StartOptions } from "@tomradex/code-link";
import { useEffect, useState } from "react";
import { Icon } from "~/components/icons";
import { startProgress, type StartStep } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";

/**
 * What a pending Start is doing, so a long first worktree does not read as a hang: in the Start dialog and on a
 * conversation's start card. Mounted per attempt: the clock starts with it.
 */
export function StartProgressNote({ mode, general, branch }: { mode: StartOptions["mode"]; general: boolean; branch: string | null }) {
  const { t } = useI18n();
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const progress = startProgress(now - since, { mode, general });
  const label = (step: StartStep) =>
    step === "worktree" ? t("codeLink.startStepWorktree")
    : step === "branch" ? (branch ? t("codeLink.startStepBranch", { branch }) : t("codeLink.startStepBranchAny"))
    : step === "mcp" ? t("codeLink.startStepMcp")
    : step === "terminal" ? t("codeLink.startStepTerminal")
    : t("codeLink.startStepAgent");
  return (
    <div className="start-progress" role="status" aria-live="polite" data-testid="start-progress" data-step={progress.steps[progress.current]}>
      <div className="start-progress-head">
        <Icon name="i-sync" size={15} className="is-spinning" />
        <span className="start-progress-step" data-testid="start-progress-step">{label(progress.steps[progress.current])}…</span>
        <span className="spacer" />
        <span className="meta-txt num">
          {t("codeLink.startStepCount", { n: String(progress.current + 1), total: String(progress.steps.length) })} · {t("codeLink.startElapsed", { seconds: String(Math.floor((now - since) / 1000)) })}
        </span>
      </div>
      <div className="start-progress-bar" aria-hidden><span /></div>
      <ol className="start-progress-steps">
        {progress.steps.map((step, index) => (
          <li key={step} data-state={index < progress.current ? "done" : index === progress.current ? "current" : "next"}>{label(step)}</li>
        ))}
      </ol>
      {progress.slow && <p className="meta-txt" data-testid="start-progress-slow">{t("codeLink.startSlow")}</p>}
      {progress.stalled && <p className="meta-txt" data-testid="start-progress-stalled">{t("codeLink.startStalled")}</p>}
    </div>
  );
}
