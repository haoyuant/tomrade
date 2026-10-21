import { useEffect, useState } from "react";
import type { EngineSetupFailure, EngineSetupProgress, EngineView } from "@tomradex/agent";
import { useCurrentProject } from "~/components/dialogs/plugins/parts";
import { Icon } from "~/components/icons";
import { duration } from "~/components/workspace/agent-panel/format";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useSetupChain, type ChainStep } from "~/lib/setupChain";
import { openExternal } from "~/lib/shell";

const FAILURE_KEYS: Record<string, MessageKey> = {
  network: "setup.failNetwork",
  registry: "setup.failRegistry",
  permission: "setup.failPermission",
  "disk-full": "setup.failDiskFull",
  unsupported: "setup.failUnsupported",
  "not-found": "setup.failNotFound",
  "not-on-path": "setup.failNotOnPath",
  timeout: "setup.failTimeout",
  cancelled: "setup.failCancelled"
};

const registryName = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function MirrorRetry({ progress, onRetry }: { progress?: EngineSetupProgress; onRetry: (registry?: string) => void }) {
  const { t } = useI18n();
  const mirror = progress?.mirror;
  if (!mirror) return null;
  return (
    <button type="button" className="link-btn setup-action setup-retry" data-testid="chain-retry-mirror" onClick={() => onRetry(mirror)}>
      {t("setup.retryMirror", { registry: registryName(mirror) })} →
    </button>
  );
}

/** A running install: the time it has taken, npm's latest line, and a word when it goes quiet. */
function InstallRunning({ progress, onRetry }: { progress?: EngineSetupProgress; onRetry: (registry?: string) => void }) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const startedAt = progress?.startedAt;
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (progress?.phase === "checking") return <span className="meta-txt">{t("setup.installChecking")}</span>;
  const latest = progress?.output?.split("\n").at(-1);
  return (
    <span className="meta-txt">
      {startedAt ? t("setup.installingFor", { elapsed: duration(t, Date.now() - startedAt) }) : t("setup.installing")}
      {latest && <code className="setup-live" data-testid="chain-live-line">{latest}</code>}
      {progress?.stalled ? (
        <span className="setup-fix" role="status" data-testid="chain-stalled">
          {t("setup.installStalled")}
          <button type="button" className="link-btn setup-action setup-retry" onClick={() => onRetry()}>
            {t("setup.retry")} →
          </button>
        </span>
      ) : (
        progress?.mirror && <span className="setup-fix">{t("setup.registrySlow")}</span>
      )}
      <MirrorRetry progress={progress} onRetry={onRetry} />
      {progress?.output && (
        <details className="eng-try-details">
          <summary>{t("setup.failOutput")}</summary>
          <pre>{progress.output}</pre>
        </details>
      )}
    </span>
  );
}

/** The ways the agent itself offers to sign in: the one running, the others to switch to, and what only a person can do. */
function SignInMethods({ progress, onSignIn }: { progress?: EngineSetupProgress; onSignIn: (method: string) => void }) {
  const { t } = useI18n();
  const methods = progress?.methods ?? [];
  if (!methods.length) return null;
  const current = methods.find((m) => m.id === progress?.method);
  return (
    <span className="setup-methods" data-testid="chain-signin-methods">
      {current && <span className="meta-txt">{t("setup.signInWith", { method: current.name })}</span>}
      {methods.filter((m) => m !== current).map((m) =>
        m.kind === "other" ? (
          <span key={m.id} className="meta-txt">{t("setup.signInByHand", { method: m.description ? `${m.name} — ${m.description}` : m.name })}</span>
        ) : (
          <button key={m.id} type="button" className="link-btn setup-action" data-testid={`chain-signin-method-${m.id}`} onClick={() => onSignIn(m.id)}>
            {t("setup.signInInstead", { method: m.name })} →
          </button>
        )
      )}
    </span>
  );
}

function StepDetail({ step, title, insideApp, onRetry, onSignIn }: { step: ChainStep; title: string; insideApp?: string; onRetry: (registry?: string) => void; onSignIn: (method: string) => void }) {
  const { t } = useI18n();
  const progress = step.progress;
  const methods = step.id === "sign-in" && <SignInMethods progress={progress} onSignIn={onSignIn} />;
  if (step.state === "failed") {
    const failure: EngineSetupFailure | undefined = progress?.failure ?? (step.tried ? { kind: "exit", message: step.tried.error ?? "" } : undefined);
    if (!failure) return null;
    const known = FAILURE_KEYS[failure.kind];
    return (
      <span className="setup-fix" role="alert" data-testid={`chain-error-${step.id}`}>
        {step.id === "test"
          ? t("setup.testFailed", { error: failure.message })
          : failure.path
            ? t("setup.failFoundBroken", { path: failure.path, error: failure.message })
            : known ? t(known) : t("setup.failExit", { error: failure.message })}
        {step.id === "test" && insideApp && <> {t("setup.insideApp", { app: insideApp })}</>}
        {step.id === "install" && <MirrorRetry progress={progress} onRetry={onRetry} />}
        {methods}
        {progress?.output && (
          <details className="eng-try-details">
            <summary>{t("setup.failOutput")}</summary>
            <pre>{progress.output}</pre>
          </details>
        )}
      </span>
    );
  }
  if (step.id === "test") {
    if (step.state === "active") return <span className="meta-txt">{t("setup.testing")}</span>;
    if (step.tried?.ok) return <span className="meta-txt" data-testid="chain-reply">{t("setup.testReply", { reply: step.tried.reply ?? "" })}</span>;
    return null;
  }
  if (step.state === "active") return step.id === "install" ? <InstallRunning progress={progress} onRetry={onRetry} /> : <span className="meta-txt">{t("setup.signingIn")}{methods}</span>;
  if (step.state === "waiting") {
    return (
      <span className="meta-txt">
        {progress?.terminal ? t("setup.signInTerminalWait") : t("setup.signingIn")}
        {progress?.url && (
          <button type="button" className="link-btn setup-action" data-testid="chain-signin-link" onClick={() => openExternal(progress.url!)}>
            {t("setup.openSignIn", { title })} →
          </button>
        )}
        {methods}
      </span>
    );
  }
  if (step.id === "install" && step.state === "done" && step.progress?.version) return <span className="meta-txt">{step.progress.version}</span>;
  return null;
}

const STEP_LABELS: Record<ChainStep["id"], MessageKey> = { install: "setup.stepInstall", "sign-in": "setup.stepSignIn", test: "setup.stepTest" };

/**
 * The one primary button that makes an agent ready, and the step list it runs
 * through: install → sign in → a test message, each ticked when already
 * satisfied. Ready means the test message got a reply, nothing less.
 */
export function SetupChain({ engine, onTroubleshoot }: { engine: EngineView; onTroubleshoot?: (engineId: string, error?: string) => void }) {
  const { t } = useI18n();
  const projectId = useCurrentProject();
  const chain = useSetupChain(engine, projectId ?? null);
  const steps = chain.steps;
  const ready = !chain.running && engine.tried?.ok && engine.ok;
  const showList = chain.running || !!chain.run;
  // The troubleshooter is offered only once a retry also failed the test: the first failure stays with the chain's own fix wording.
  const running = chain.running;
  const testFailed = !!chain.run?.failed && chain.run.step === "test";
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    if (!running && testFailed) setFailures((n) => n + 1);
  }, [running, testFailed]);
  const lastError = chain.run?.tried?.error ?? chain.run?.progress?.failure?.message ?? engine.tried?.error;
  const icon = (step: ChainStep) =>
    step.state === "done" ? <Icon name="i-check" size={12} /> : step.state === "failed" ? <Icon name="i-warn" size={12} /> : step.state === "pending" ? <span className="setup-step-dot" /> : <Icon name="i-sync" size={12} />;
  return (
    <div className="setup-chain" data-testid={`chain-${engine.id}`}>
      {!ready && (
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <button type="button" className="btn btn-primary btn-sm" data-testid={`setup-run-${engine.id}`} disabled={chain.running} onClick={chain.start}>
            {chain.running ? t("setup.oneClickRunning") : chain.official ? t("setup.installOfficial") : chain.run?.failed ? t("setup.retry") : t("setup.oneClick")}
          </button>
          {chain.running && (
            <button type="button" className="btn btn-ghost btn-xs" data-testid={`setup-cancel-${engine.id}`} onClick={chain.cancel}>
              {t("setup.cancelSetup")}
            </button>
          )}
          {onTroubleshoot && !chain.running && failures >= 2 && (
            <button type="button" className="link-btn" data-testid={`chain-troubleshoot-${engine.id}`} onClick={() => onTroubleshoot(engine.id, lastError)}>
              {t("setup.troubleshoot")} →
            </button>
          )}
        </span>
      )}
      {showList && (
        <ol className="setup-steps">
          {steps.map((step) => (
            <li key={step.id} data-step={step.id} data-state={step.state}>
              {icon(step)}
              <div className="setup-step-body">
                <span>{t(step.official ? "setup.stepInstallOfficial" : STEP_LABELS[step.id], { title: engine.title })}</span>
                <StepDetail step={step} title={engine.title} insideApp={engine.cli?.insideApp} onRetry={chain.retry} onSignIn={chain.signInWith} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
