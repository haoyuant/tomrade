import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EngineView } from "@tomradex/agent";
import type { WorkerStatus } from "@tomradex/llm";
import { agentKeys, useEngines } from "./agent";
import { invoke } from "./api";
import { useI18n } from "./i18n";
import { engineStatus } from "./localCli";
import { keys, useSettings } from "./queries";

const setupKeys = {
  worker: ["llm", "worker"] as const,
  providers: (locale: string) => ["llm", "providers", locale] as const,
  detected: ["llm", "detected"] as const
};

/** An engine a ticket can be handed to: it works on this computer, not only through Tomrade's tools. */
export const isLocalAgent = (engine: EngineView): boolean => engine.capabilities.includes("code") || engine.capabilities.includes("general");

/** The local agents worth a setup row: the suggested ones, and any other found on this computer. */
export const setupRows = (engines: EngineView[]): EngineView[] =>
  engines.filter((e) => e.setup && isLocalAgent(e) && (e.setup.suggested || engineStatus(e) !== "missing"));

/**
 * Whether Tomrade can work yet. Either a model or a signed-in local agent is
 * enough: a model also runs the built-in agent, and a local agent lends its
 * model for planning — so one step sets up both.
 */
export function setupState(engines: EngineView[], worker: WorkerStatus) {
  const assistant = engines.filter((e) => e.ok && e.capabilities.includes("backlog"));
  return { complete: worker.ok && assistant.length > 0, assistant, locals: engines.filter((e) => e.ok && isLocalAgent(e)), worker };
}

/** Engines and the worker, looked at again whenever settings change — a key saved anywhere shows here. */
export function useSetup() {
  const engines = useEngines();
  const settings = useSettings();
  const worker = useQuery({ queryKey: setupKeys.worker, queryFn: () => invoke("llm.worker"), staleTime: 15_000 });
  const refetchEngines = engines.refetch;
  const refetchWorker = worker.refetch;
  useEffect(() => {
    void refetchEngines();
  }, [settings.data, refetchEngines]);
  // A local agent signed in or out changes who can plan.
  useEffect(() => {
    void refetchWorker();
  }, [engines.data, refetchWorker]);
  const state = engines.data && worker.data ? setupState(engines.data, worker.data) : null;
  return { engines: engines.data, worker: worker.data, state };
}

export const useProviders = () => {
  const { locale } = useI18n();
  return useQuery({ queryKey: setupKeys.providers(locale), queryFn: () => invoke("llm.providers"), staleTime: Infinity });
};

export const useDetected = () => useQuery({ queryKey: setupKeys.detected, queryFn: () => invoke("llm.detect"), staleTime: 30_000 });

/** After a model or agent is connected: settings, engines, the worker and what is left to detect. */
function useRefreshSetup() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: keys.settings });
    void qc.invalidateQueries({ queryKey: agentKeys.engines });
    void qc.invalidateQueries({ queryKey: setupKeys.worker });
    void qc.invalidateQueries({ queryKey: setupKeys.detected });
  }, [qc]);
}

export function useQuickSetup() {
  const refresh = useRefreshSetup();
  return useMutation({
    mutationFn: (input: { preset: string; apiKey?: string }) => invoke("llm.quickSetup", input),
    onSuccess: (result) => result.ok && refresh()
  });
}

export function useAdoptDetected() {
  const refresh = useRefreshSetup();
  return useMutation({ mutationFn: (id: string) => invoke("llm.adopt", id), onSuccess: (result) => result.ok && refresh() });
}

/** Opens a terminal running the engine's own install or sign-in command; the window coming back into focus looks again. */
export const useSetupInTerminal = () =>
  useMutation({ mutationFn: ({ engineId, step }: { engineId: string; step: "install" | "signIn" }) => invoke("codeLink.setupInTerminal", engineId, step) });
