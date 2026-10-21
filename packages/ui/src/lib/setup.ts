import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EngineView } from "@tomradex/agent";
import type { Providing } from "@tomradex/community";
import type { ProviderView, WorkerStatus } from "@tomradex/llm";
import { agentKeys, useEngines } from "./agent";
import { invoke, subscribe } from "./api";
import { useI18n } from "./i18n";
import { engineStatus } from "./localCli";
import { useStoreInstall } from "./plugins";
import { keys, useSettings } from "./queries";

const setupKeys = {
  worker: ["llm", "worker"] as const,
  providers: (locale: string) => ["llm", "providers", locale] as const,
  modelProviders: (locale: string) => ["llm", "modelProviders", locale] as const,
  detected: ["llm", "detected"] as const,
  // under "community", so an install anywhere refetches it
  providing: ["community", "providing", "modelProviders"] as const
};

/** A provider plugin installed, switched off or removed changes what the setup offers. */
function useProvidersChanged() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe("llm.providersChanged", () => {
        void qc.invalidateQueries({ queryKey: ["llm", "providers"] });
        void qc.invalidateQueries({ queryKey: ["llm", "modelProviders"] });
      }),
    [qc]
  );
}

/** An engine a ticket can be handed to: it works on this computer, not only through Tomrade's tools. */
const isLocalAgent = (engine: EngineView): boolean => engine.capabilities.includes("code") || engine.capabilities.includes("general");

/** The local agents worth a setup row: the suggested ones, and any other found on this computer. */
export const setupRows = (engines: EngineView[]): EngineView[] =>
  engines.filter((e) => e.setup && isLocalAgent(e) && (e.setup.suggested || engineStatus(e) !== "missing"));

/**
 * Whether Tomrade can work yet. Either a model or a signed-in local agent is
 * enough: a model also runs the built-in agent, and a local agent lends its
 * model for planning — so one step sets up both.
 */
function setupState(engines: EngineView[], worker: WorkerStatus) {
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
  useProvidersChanged();
  return useQuery({ queryKey: setupKeys.providers(locale), queryFn: () => invoke("llm.providers"), staleTime: Infinity });
};

/** The model providers profiles can name, as the profile form draws them. */
export const useModelProviders = () => {
  const { locale } = useI18n();
  useProvidersChanged();
  return useQuery({ queryKey: setupKeys.modelProviders(locale), queryFn: () => invoke("llm.modelProviders"), staleTime: Infinity });
};

/** Official plugins that bring a model provider, not installed: offered beside the presets. None when the catalog cannot be read. */
export const useProviderPlugins = () =>
  useQuery({ queryKey: setupKeys.providing, queryFn: () => invoke("community.providing", "modelProviders"), staleTime: 5 * 60_000, retry: false });

/** How long an installed provider plugin has to offer its presets before the setup says it did not. */
const PROVIDER_READY_MS = 15_000;

/**
 * One click from a provider plugin to its preset: installs the plugin, then
 * hands `onReady` its first preset once the plugin has registered it, which
 * comes a moment after the install.
 */
export function useInstallProvider(onReady: (preset: ProviderView) => void) {
  const install = useStoreInstall();
  const presets = useProviders();
  const [waiting, setWaiting] = useState<Providing | null>(null);
  const [stalled, setStalled] = useState<Providing | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (!waiting) return;
    const preset = presets.data?.find((p) => waiting.ids.includes(p.provider));
    if (preset) {
      setWaiting(null);
      ready.current(preset);
      return;
    }
    const timer = setTimeout(() => {
      setWaiting(null);
      setStalled(waiting);
    }, PROVIDER_READY_MS);
    return () => clearTimeout(timer);
  }, [waiting, presets.data]);
  return {
    install: (plugin: Providing) => {
      setStalled(null);
      install.mutate({ id: plugin.id }, { onSuccess: () => setWaiting(plugin) });
    },
    /** The plugin being installed or awaited. */
    busy: install.isPending ? (install.variables?.id ?? null) : (waiting?.id ?? null),
    /** The plugin that did not install, and why. */
    failed: install.isError ? { id: install.variables?.id, error: install.error } : null,
    stalled
  };
}

/** Runs a provider's own sign-in in the browser; resolves to the key it ends in. */
export const useProviderSignIn = () => useMutation({ mutationFn: (provider: string) => invoke("llm.signIn", provider) });

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
