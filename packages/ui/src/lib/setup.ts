import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentSettings, EngineView } from "@tomradex/agent";
import type { Providing } from "@tomradex/community";
import type { ProviderView } from "@tomradex/llm";
import { useEngines } from "./agent";
import { invoke, logQuietly, subscribe } from "./api";
import { awaitsTry } from "./engines";
import { useI18n } from "./i18n";
import { engineStatus } from "./localCli";
import { useStoreInstall } from "./plugins";
import { keys, useSettings } from "./queries";
import { isLocalAgent, setupState, type WorkerTested } from "./setupState";

/** A provider plugin installed, switched off or removed changes what the setup offers. */
function useProvidersChanged() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe("llm.providersChanged", () => {
        void qc.invalidateQueries({ queryKey: keys.llm.providersAll });
        void qc.invalidateQueries({ queryKey: keys.llm.modelProvidersAll });
      }),
    [qc]
  );
}

/** The local agents worth a setup row: the suggested ones, and any other found on this computer. */
export const setupRows = (engines: EngineView[]): EngineView[] =>
  engines.filter((e) => e.setup && isLocalAgent(e) && (e.setup.suggested || engineStatus(e) !== "missing"));

/** The worker profile's remembered one-token test, and the retry that asks again. Null test while the worker is not a profile. */
export function useWorkerTest() {
  const qc = useQueryClient();
  const worker = useQuery({ queryKey: keys.llm.worker, queryFn: () => invoke("llm.worker"), staleTime: 15_000 });
  const viaProfile = worker.data?.ok === true && worker.data.via === "profile";
  const test = useQuery({ queryKey: keys.llm.workerTest, queryFn: () => invoke("llm.workerTest"), enabled: viaProfile, staleTime: Infinity, retry: false });
  // Through the query, not a mutation, so every watcher sees the one retest run.
  const retest = () => void qc.fetchQuery({ queryKey: keys.llm.workerTest, queryFn: () => invoke("llm.workerTest", true) }).catch(() => {});
  return { worker: worker.data, viaProfile, test: test.data ?? null, pending: viaProfile && (test.isPending || test.isFetching), retest };
}

/** One automatic test message per engine, CLI and settings for the whole session, however many screens ask. */
const autoTried = new Set<string>();

/**
 * A found and signed-in agent counts only once a test message got a reply, so
 * setup sends that message itself. A failed one stays failed until the person
 * retries it; a new CLI or new settings get their own.
 */
function useAutoTry(engines: EngineView[] | undefined, options: AgentSettings["engines"] | undefined, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !engines) return;
    for (const engine of engines) {
      if (!awaitsTry(engine) || !(engine.capabilities.includes("backlog") || isLocalAgent(engine))) continue;
      const key = JSON.stringify([engine.id, engine.cli?.path ?? null, options?.[engine.id] ?? null]);
      if (autoTried.has(key)) continue;
      autoTried.add(key);
      void invoke("agent.tryEngine", null, engine.id)
        .catch(logQuietly("agent.tryEngine"))
        .finally(() => void qc.invalidateQueries({ queryKey: keys.agent.engines }));
    }
  }, [engines, options, enabled, qc]);
}

/**
 * Engines and the worker, looked at again whenever settings change — a key saved anywhere shows here.
 * `autoTry`: where setup is on screen, an agent found and signed in is sent its test message.
 */
export function useSetup(opts: { autoTry?: boolean } = {}) {
  const engines = useEngines();
  const settings = useSettings();
  useAutoTry(engines.data, (settings.data?.agent as AgentSettings | undefined)?.engines, !!opts.autoTry);
  const worker = useQuery({ queryKey: keys.llm.worker, queryFn: () => invoke("llm.worker"), staleTime: 15_000 });
  const { viaProfile, test, pending } = useWorkerTest();
  const refetchEngines = engines.refetch;
  const refetchWorker = worker.refetch;
  useEffect(() => {
    void refetchEngines();
  }, [settings.data, refetchEngines]);
  // A local agent signed in or out changes who can plan.
  useEffect(() => {
    void refetchWorker();
  }, [engines.data, refetchWorker]);
  // A profile edited anywhere is tested again: the remembered outcome is per key, model and endpoint.
  const qc = useQueryClient();
  useEffect(() => {
    if (viaProfile) void qc.invalidateQueries({ queryKey: keys.llm.workerTest });
  }, [settings.data, viaProfile, qc]);
  const tested: WorkerTested | undefined = !viaProfile ? undefined : pending ? "pending" : test ? { ok: test.ok } : undefined;
  const state = engines.data && worker.data ? setupState(engines.data, worker.data, tested) : null;
  return { engines: engines.data, worker: worker.data, state };
}

export const useProviders = () => {
  const { locale } = useI18n();
  useProvidersChanged();
  return useQuery({ queryKey: keys.llm.providers(locale), queryFn: () => invoke("llm.providers"), staleTime: Infinity });
};

/** The model providers profiles can name, as the profile form draws them. */
export const useModelProviders = () => {
  const { locale } = useI18n();
  useProvidersChanged();
  return useQuery({ queryKey: keys.llm.modelProviders(locale), queryFn: () => invoke("llm.modelProviders"), staleTime: Infinity });
};

/** Official plugins that bring a model provider, not installed: offered beside the presets. None when the catalog cannot be read. */
export const useProviderPlugins = () =>
  useQuery({ queryKey: keys.community.providingModels, queryFn: () => invoke("community.providing", "modelProviders"), staleTime: 5 * 60_000, retry: false });

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

export const useDetected = () => useQuery({ queryKey: keys.llm.detected, queryFn: () => invoke("llm.detect"), staleTime: 30_000 });

/** After a model or agent is connected: settings, engines, the worker and what is left to detect. */
function useRefreshSetup() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: keys.settings });
    void qc.invalidateQueries({ queryKey: keys.agent.engines });
    void qc.invalidateQueries({ queryKey: keys.llm.worker });
    void qc.invalidateQueries({ queryKey: keys.llm.workerTest });
    void qc.invalidateQueries({ queryKey: keys.llm.detected });
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
