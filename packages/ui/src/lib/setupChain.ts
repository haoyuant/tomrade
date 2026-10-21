import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EngineSetupProgress, EngineTry, EngineView } from "@tomradex/agent";
// the agentSetup.* channels
import type {} from "@tomradex/agent-setup";
import { invoke, subscribe } from "./api";
import { engineStatus } from "./localCli";
import { keys } from "./queries";
import { useSetupInTerminal } from "./setup";

/**
 * The one-click chain: install (if needed) → sign in (if needed) → a test
 * message, each step run by the backend (agentSetup.*, agent.tryEngine) and
 * shown as a list. An agent counts as configured only once the test message
 * got a reply — the same `tried` state the rest of setup reads.
 */

export type ChainStepId = "install" | "sign-in" | "test";
export type ChainStepState = "done" | "active" | "waiting" | "pending" | "failed";

export interface ChainStep {
  id: ChainStepId;
  state: ChainStepState;
  /** The backend's progress while the step runs or after it failed. */
  progress?: EngineSetupProgress;
  /** The test step's outcome. */
  tried?: EngineTry;
}

export const needsInstall = (engine: EngineView): boolean => ["missing", "desktop-only", "broken"].includes(engineStatus(engine));
export const needsSignIn = (engine: EngineView): boolean => engineStatus(engine) === "sign-in";

/** What the chain would run for this engine now, each step ticked or still ahead. */
export function chainSteps(engine: EngineView, run: ChainRun | null): ChainStep[] {
  const stepState = (id: ChainStepId, satisfied: boolean): ChainStep => {
    // A step that ran keeps its outcome; one still running shows where it is; the rest tick off the engine's state.
    const past = run?.outcomes[id];
    if (past) return past;
    if (run?.step === id) {
      const phase = run.progress?.phase;
      return {
        id,
        state: run.failed ? "failed" : phase === "waiting" ? "waiting" : "active",
        ...(run.progress ? { progress: run.progress } : {}),
        ...(id === "test" && run.tried ? { tried: run.tried } : {})
      };
    }
    return { id, state: satisfied ? "done" : "pending" };
  };
  return [
    stepState("install", !needsInstall(engine)),
    stepState("sign-in", !needsInstall(engine) && !needsSignIn(engine) && !!engine.ok),
    stepState("test", !!engine.tried?.ok)
  ];
}

export interface ChainRun {
  running: boolean;
  /** The step being run; none once the chain ended. */
  step?: ChainStepId;
  progress?: EngineSetupProgress;
  tried?: EngineTry;
  failed?: boolean;
  /** Each finished step's outcome, kept for the list after the run. */
  outcomes: Partial<Record<ChainStepId, ChainStep>>;
}

const POLL_MS = 400;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useSetupChain(engine: EngineView, projectId?: string | null) {
  const qc = useQueryClient();
  const terminal = useSetupInTerminal();
  const [run, setRun] = useState<ChainRun | null>(null);
  const alive = useRef(true);
  // Set on mount too: strict mode replays the effect pair on the same instance.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const cancelled = useRef(false);
  const state = useRef<ChainRun | null>(null);
  const patch = (change: Partial<ChainRun>) => {
    if (!alive.current || !state.current) return;
    state.current = { ...state.current, ...change };
    setRun(state.current);
  };

  // The backend's broadcasts move the list between polls.
  const engineId = engine.id;
  useEffect(
    () =>
      subscribe("agentSetup.event", (progress) => {
        if (progress.engineId === engineId && state.current?.running && state.current.step !== "test") patch({ progress });
      }),
    [engineId]
  );

  const terminalOpened = useRef(false);
  const openTerminal = terminal.mutate;
  const latest = useRef(engine);
  latest.current = engine;

  /** One agentSetup step to its end, the UI following along. */
  const drive = async (step: "install" | "sign-in", registry?: string): Promise<EngineSetupProgress> => {
    let progress = await invoke("agentSetup.start", engineId, step, step === "install" && registry ? { registry } : {});
    patch({ step, progress });
    while (progress.phase !== "done" && progress.phase !== "failed") {
      // A terminal sign-in is opened for the person once; the probe moves the step on by itself.
      if (step === "sign-in" && progress.phase === "waiting" && progress.terminal && !terminalOpened.current) {
        terminalOpened.current = true;
        openTerminal({ engineId, step: "signIn" });
      }
      await wait(POLL_MS);
      if (cancelled.current) void invoke("agentSetup.cancel", engineId);
      progress = (await invoke("agentSetup.state", engineId)) ?? progress;
      patch({ progress });
    }
    return progress;
  };

  const start = async (registry?: string) => {
    if (state.current?.running) return;
    cancelled.current = false;
    terminalOpened.current = false;
    state.current = { running: true, outcomes: {} };
    setRun(state.current);
    try {
      // The backend runs each step only as far as needed — one already satisfied comes back done at
      // once — so the chain never waits on a fresh look of every engine here.
      const view = latest.current;
      const steps: ("install" | "sign-in")[] = needsInstall(view) ? ["install", "sign-in"] : needsSignIn(view) || !view.ok ? ["sign-in"] : [];
      for (const step of steps) {
        const end = await drive(step, registry);
        patch({ outcomes: { ...state.current?.outcomes, [step]: { id: step, state: end.phase === "done" ? "done" : "failed", progress: end } } });
        if (end.phase !== "done") return patch({ running: false, failed: true });
      }
      if (cancelled.current) return patch({ running: false, failed: true });
      patch({ step: "test", progress: undefined });
      const tried = await invoke("agent.tryEngine", projectId ?? null, engineId).catch(
        (error): EngineTry => ({ ok: false, ms: 0, at: Date.now(), error: error instanceof Error ? error.message : String(error) })
      );
      patch({
        running: false,
        failed: !tried.ok,
        tried,
        outcomes: { ...state.current?.outcomes, test: { id: "test", state: tried.ok ? "done" : "failed", tried } }
      });
      await qc.invalidateQueries({ queryKey: keys.agent.engines });
      await qc.invalidateQueries({ queryKey: keys.llm.worker });
    } catch (error) {
      const progress: EngineSetupProgress = { engineId, step: "install", phase: "failed", failure: { kind: "exit", message: error instanceof Error ? error.message : String(error) } };
      patch({ running: false, failed: true, progress });
    }
  };

  const cancel = () => {
    cancelled.current = true;
    void invoke("agentSetup.cancel", engineId);
  };

  const current = useRef<Promise<void> | null>(null);
  const begin = (registry?: string) => {
    current.current = start(registry);
  };
  /** Starts over, stopping a run that is still going first; `registry` goes to npm for this install only. */
  const retry = async (registry?: string) => {
    if (state.current?.running) {
      cancel();
      await current.current;
    }
    begin(registry);
  };

  return { run, steps: chainSteps(engine, run), start: () => begin(), retry: (registry?: string) => void retry(registry), cancel, running: !!run?.running };
}
