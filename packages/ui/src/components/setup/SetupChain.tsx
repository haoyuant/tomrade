import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentSettings, EngineSetupFailure, EngineSetupProgress, EngineView } from "@tomradex/agent";
import { useCurrentProject } from "~/components/dialogs/plugins/parts";
import { Icon } from "~/components/icons";
import { duration, type Translate } from "~/components/workspace/agent-panel/format";
import { invoke } from "~/lib/api";
import { pickChoiceName, pickTitleOf } from "~/lib/engines";
import { formatSize } from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { keys, useSaveSettings, useSettings } from "~/lib/queries";
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
  "native-missing": "setup.failNativeMissing",
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

/** Re-renders every second while `on`, for the times a step counts. */
function useSecondTick(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

const INSTALLER_KEYS: Record<string, MessageKey> = { script: "setup.installerScript", npm: "setup.installerNpm", brew: "setup.installerBrew", archive: "setup.installerArchive" };
const installerName = (t: Translate, kind: string) => (INSTALLER_KEYS[kind] ? t(INSTALLER_KEYS[kind]) : kind);

const STAGE_KEYS: Record<NonNullable<EngineSetupProgress["stage"]>, MessageKey> = {
  download: "setup.stageDownload",
  unpack: "setup.stageUnpack",
  resolve: "setup.stageResolve",
  fetch: "setup.stageFetch",
  link: "setup.stageLink"
};

/** An installer that gave way because it does not fit here, not because it failed. */
const UNFIT_KINDS: EngineSetupFailure["kind"][] = ["unsupported", "not-found"];

/** Quiet this long, a step says when it last heard from the installer — well before the backend calls it stalled. */
const QUIET_MS = 15_000;

/** What it printed: the latest line as it comes, the tail of the rest behind a disclosure. */
function LiveOutput({ output }: { output?: string }) {
  const { t } = useI18n();
  if (!output) return null;
  const latest = output.split("\n").at(-1);
  return (
    <>
      {latest && <code className="setup-live" data-testid="chain-live-line">{latest}</code>}
      <details className="eng-try-details">
        <summary>{t("setup.failOutput")}</summary>
        <pre>{output}</pre>
      </details>
    </>
  );
}

/** What the installer is doing now, as its own words say, with a bar while a download's size is known. */
function InstallStage({ progress }: { progress: EngineSetupProgress }) {
  const { t } = useI18n();
  const { stage, received, size } = progress;
  if (!stage) return null;
  const downloading = stage === "download" && received !== undefined;
  const percent = downloading && size ? Math.min(100, Math.floor((received / size) * 100)) : null;
  return (
    <span className="setup-line" data-testid="chain-stage" data-stage={stage}>
      {stage === "fetch" ? t("setup.stageFetch", { n: progress.packages ?? 0 }) : t(STAGE_KEYS[stage])}
      {downloading && " · "}
      {downloading && (size ? t("setup.downloadedOf", { received: formatSize(received), size: formatSize(size), percent: percent ?? 0 }) : t("setup.downloaded", { received: formatSize(received) }))}
      {percent !== null && (
        <span className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}

/** A running install: which installer of how many and for how long, why the last one gave way, its stage, its latest line, and a word when it goes quiet. */
function InstallRunning({ progress, onRetry }: { progress?: EngineSetupProgress; onRetry: (registry?: string) => void }) {
  const { t } = useI18n();
  const startedAt = progress?.startedAt;
  useSecondTick(!!startedAt);
  if (progress?.phase === "checking") return <span className="meta-txt">{t("setup.installChecking")}</span>;
  const kind = progress?.installer;
  const installer = kind && ((progress.attempts ?? 1) > 1 ? t("setup.installerAt", { installer: installerName(t, kind), n: progress.attempt ?? 1, total: progress.attempts ?? 1 }) : installerName(t, kind));
  const elapsed = startedAt ? duration(t, Date.now() - startedAt) : null;
  const previous = progress?.previous;
  const quiet = startedAt ? Date.now() - (progress.lastOutputAt ?? startedAt) : 0;
  const ago = duration(t, quiet);
  return (
    <span className="meta-txt">
      <span className="setup-line" data-testid="chain-install-attempt">
        {elapsed ? (installer ? t("setup.installingWith", { installer, elapsed }) : t("setup.installingFor", { elapsed })) : t("setup.installing")}
      </span>
      {previous && kind && previous.installer !== kind && (
        <span className="setup-fix" data-testid="chain-switched">
          {t(UNFIT_KINDS.includes(previous.kind) ? "setup.installSwitchUnfit" : "setup.installSwitchFailed", { previous: installerName(t, previous.installer), installer: installerName(t, kind) })}
        </span>
      )}
      {progress && <InstallStage progress={progress} />}
      <LiveOutput output={progress?.output} />
      {progress?.stalled ? (
        <span className="setup-fix" role="status" data-testid="chain-stalled">
          {t("setup.installStalled", { ago })}
          <button type="button" className="link-btn setup-action setup-retry" onClick={() => onRetry()}>
            {t("setup.retry")} →
          </button>
        </span>
      ) : (
        <>
          {quiet >= QUIET_MS && (
            <span className="setup-line" role="status" data-testid="chain-quiet">
              {progress?.lastOutputAt ? t("setup.installQuiet", { ago }) : t("setup.installQuietNone", { ago })}
            </span>
          )}
          {progress?.mirror && <span className="setup-fix">{t("setup.registrySlow")}</span>}
        </>
      )}
      {progress?.prefix && <span className="setup-fix">{t("setup.installOwnFolder")}</span>}
      <MirrorRetry progress={progress} onRetry={onRetry} />
    </span>
  );
}

/** A sign-in under way: how long it has waited, that it goes on by itself, the address to open and what the command printed. */
function SignInWait({ progress, title, children }: { progress?: EngineSetupProgress; title: string; children?: ReactNode }) {
  const { t } = useI18n();
  const startedAt = progress?.startedAt;
  useSecondTick(!!startedAt);
  const elapsed = startedAt ? duration(t, Date.now() - startedAt) : null;
  return (
    <span className="meta-txt" data-testid="chain-signin-wait">
      {progress?.terminal ? (
        <>
          {t("setup.signInTerminalWait")}
          {elapsed && <span className="setup-line">{t("setup.waitedFor", { elapsed })}</span>}
        </>
      ) : elapsed ? t("setup.signInWaited", { elapsed }) : t("setup.signingIn")}
      {progress?.url && (
        <button type="button" className="link-btn setup-action" data-testid="chain-signin-link" onClick={() => openExternal(progress.url!)}>
          {t("setup.openSignIn", { title })} →
        </button>
      )}
      <LiveOutput output={progress?.output} />
      {children}
    </span>
  );
}

/** The test message is out: how long its reply has been awaited. */
function TestWaiting({ startedAt }: { startedAt?: number }) {
  const { t } = useI18n();
  useSecondTick(!!startedAt);
  return <span className="meta-txt" data-testid="chain-test-wait">{startedAt ? t("setup.testWaiting", { elapsed: duration(t, Date.now() - startedAt) }) : t("setup.testing")}</span>;
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

function StepDetail({ step, title, insideApp, terminalOnly, onRetry, onSignIn }: { step: ChainStep; title: string; insideApp?: string; terminalOnly?: boolean; onRetry: (registry?: string) => void; onSignIn: (method: string) => void }) {
  const { t } = useI18n();
  const progress = step.progress;
  const methods = step.id === "sign-in" && <SignInMethods progress={progress} onSignIn={onSignIn} />;
  if (step.id === "terminal") return step.state === "done" ? <span className="meta-txt" data-testid="chain-terminal-ready">{t("setup.terminalReady", { title })}</span> : null;
  if (step.state === "failed") {
    const failure: EngineSetupFailure | undefined = progress?.failure ?? (step.tried ? { kind: "exit", message: step.tried.error ?? "" } : undefined);
    if (!failure) return null;
    const known = FAILURE_KEYS[failure.kind];
    return (
      <span className="setup-fix" role="alert" data-testid={`chain-error-${step.id}`}>
        {step.id === "test"
          ? t("setup.testFailed", { error: failure.message })
          : failure.path && failure.kind !== "native-missing"
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
    if (step.state === "active") return <TestWaiting startedAt={step.startedAt} />;
    if (step.tried?.ok) {
      return (
        <>
          <span className="meta-txt" data-testid="chain-reply">{t("setup.testReply", { reply: step.tried.reply ?? "" })}</span>
          {terminalOnly && <span className="meta-txt" data-testid="chain-terminal-ready">{t("setup.terminalReady", { title })}</span>}
        </>
      );
    }
    return null;
  }
  if (step.state === "active" && step.id === "install") return <InstallRunning progress={progress} onRetry={onRetry} />;
  if (step.state === "active" || step.state === "waiting") return <SignInWait progress={progress} title={title}>{methods}</SignInWait>;
  if (step.id === "install" && step.state === "done" && step.progress?.version) {
    return <span className="meta-txt">{step.progress.prefix ? t("setup.installedOwnFolder", { version: step.progress.version }) : step.progress.version}</span>;
  }
  return null;
}

const STEP_LABELS: Record<ChainStep["id"], MessageKey> = { install: "setup.stepInstall", "sign-in": "setup.stepSignIn", test: "setup.stepTest", terminal: "setup.stepTerminal" };

const stepLabel = (step: ChainStep): MessageKey => (step.managed ? "setup.stepInstallManaged" : step.official ? "setup.stepInstallOfficial" : STEP_LABELS[step.id]);

/** The second way forward when the person's copy is missing or failed: Tomrade's own, with what it would download. */
function ManagedButton({ engine, onClick }: { engine: EngineView; onClick: () => void }) {
  const { t } = useI18n();
  const offer = useQuery({ queryKey: keys.agentSetup.managed(engine.id), queryFn: () => invoke("agentSetup.managed", engine.id), staleTime: 10 * 60_000 });
  const bytes = offer.data?.bytes;
  return (
    <button type="button" className="btn btn-ghost btn-sm" data-testid={`setup-managed-${engine.id}`} title={t("setup.installManagedHint")} onClick={onClick}>
      {bytes ? t("setup.installManagedSize", { size: formatSize(bytes) }) : t("setup.installManaged")}
    </button>
  );
}

/**
 * The machine-wide pick an agent needs settled before it signs in — today the
 * CodeBuddy edition. Empty is the agent's own default, so choosing nothing
 * leaves the setup exactly as it was.
 */
function EditionPick({ engine, disabled }: { engine: EngineView; disabled: boolean }) {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings();
  const pick = engine.picks?.find((candidate) => candidate.global);
  const agent = settings.data?.agent as AgentSettings | undefined;
  if (!pick || !agent) return null;
  const options = (agent.engines[engine.id] ?? {}) as Record<string, unknown>;
  const value = typeof options[pick.key] === "string" ? (options[pick.key] as string) : "";
  const choose = (next: string) => {
    if (!settings.data) return;
    const nextOptions = { ...options };
    if (next) nextOptions[pick.key] = next;
    else delete nextOptions[pick.key];
    save.mutate({ ...settings.data, agent: { ...agent, engines: { ...agent.engines, [engine.id]: nextOptions } } });
  };
  return (
    <label className="setup-edition" title={t("setup.regionNote")}>
      <span className="meta-txt">{pickTitleOf(t, pick)}</span>
      <select
        className="select"
        value={value}
        disabled={disabled || save.isPending}
        data-testid={`setup-region-${engine.id}`}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">{pickChoiceName(t, pick, { value: "auto" })}</option>
        {pick.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>{pickChoiceName(t, pick, choice)}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * The one primary button that makes an agent ready, and the step list it runs
 * through: install → sign in → a test message, each ticked when already
 * satisfied. Ready means the test message got a reply, nothing less — or, for
 * an agent that runs only in a terminal, the check it can pass.
 */
export function SetupChain({ engine, onTroubleshoot }: { engine: EngineView; onTroubleshoot?: (engineId: string, error?: string) => void }) {
  const { t } = useI18n();
  const projectId = useCurrentProject();
  const chain = useSetupChain(engine, projectId ?? null);
  const steps = chain.steps;
  // One that runs only in a terminal is ready once found and signed in, unless its one answer failed.
  const ready = !chain.running && engine.ok && (engine.terminalOnly ? engine.tried?.ok !== false : !!engine.tried?.ok);
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
  if (ready && !showList) return null;
  return (
    <div className="setup-chain" data-testid={`chain-${engine.id}`}>
      {!ready && (
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <EditionPick engine={engine} disabled={chain.running} />
          <button type="button" className="btn btn-primary btn-sm" data-testid={`setup-run-${engine.id}`} disabled={chain.running} onClick={chain.start}>
            {chain.running ? t("setup.oneClickRunning") : chain.official ? t("setup.installOfficial") : chain.run?.failed ? t("setup.retry") : t("setup.oneClick")}
          </button>
          {chain.managed && <ManagedButton engine={engine} onClick={chain.startManaged} />}
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
                <span>{t(stepLabel(step), { title: engine.title })}</span>
                <StepDetail step={step} title={engine.title} insideApp={engine.cli?.insideApp} terminalOnly={engine.terminalOnly} onRetry={chain.retry} onSignIn={chain.signInWith} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {engine.cli?.state === "ready" && !engine.cli.insideApp && engine.cli.name !== "npx" && engine.setup?.installers?.some((installer) => installer.kind === "npm") && (
        <span className="meta-txt" data-testid={`chain-copy-${engine.id}`} data-copy={engine.cli.source === "managed" ? "managed" : "own"}>
          {engine.cli.source === "managed" ? t("setup.usingManaged", { version: engine.cli.version ?? "" }) : t("setup.usingOwn")}
        </span>
      )}
    </div>
  );
}
