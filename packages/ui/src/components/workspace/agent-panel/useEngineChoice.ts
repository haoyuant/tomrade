import { useEffect } from "react";
import type { AgentSettings, EnginePick, EngineView, RunView } from "@tomradex/agent";
import { findEngine, conducts, useSetOptions, useSetPermissionMode, type useAgentThread } from "~/lib/agent";
import { permissionLabel as permissionName } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { useSaveSettings, type useSettings } from "~/lib/queries";
import { STORE } from "./store";

/** Who conducts the conversation and with which knobs: the engine, its permission mode, and its quick picks. */
export function useEngineChoice({ projectId, threadId, detail, engines, settings, runningRun }: {
  projectId: string;
  threadId: string | null;
  detail: ReturnType<typeof useAgentThread>["data"];
  engines: EngineView[] | undefined;
  settings: ReturnType<typeof useSettings>["data"];
  runningRun: RunView | undefined;
}) {
  const { t } = useI18n();
  const setPermissionMode = useSetPermissionMode(projectId);
  // No thread yet: the chip shows what a new thread WOULD get, and picking an
  // engine creates the thread right there instead of doing silently nothing.
  const agentSettings = settings?.agent as AgentSettings | undefined;
  const usable = (id: string) => {
    const found = findEngine(engines, id);
    return !!found?.ok && !found.terminalOnly;
  };
  // The settings' engine may not run here yet — no model, say — while another does: a new thread takes the one that can answer.
  const configuredEngine = findEngine(engines, agentSettings?.defaultEngine)?.id ?? agentSettings?.defaultEngine ?? "tomrade";
  const defaultEngine = !engines || usable(configuredEngine) ? configuredEngine : (engines.find((e) => e.ok && !e.terminalOnly && e.capabilities.includes("backlog"))?.id ?? configuredEngine);
  const currentEngineId = detail?.thread.engine ?? defaultEngine;
  const engine = findEngine(engines, currentEngineId);
  const permissionModes = detail ? engine?.permissionModes : undefined;
  // A conversation nobody set a mode on starts in the one last picked here for this engine.
  const storedPermission = engine ? localStorage.getItem(STORE.permission(engine.id)) : null;
  const rememberedPermission = detail && !detail.thread.itemId && !detail.thread.permissionMode && permissionModes?.choices.some((c) => c.value === storedPermission) ? storedPermission! : undefined;
  const selectedPermissionMode = detail?.thread.permissionMode ?? rememberedPermission ?? permissionModes?.default;
  const activePermissionMode = runningRun ? detail?.activePermissionMode : undefined;
  // Written onto the thread, so the run uses the mode the chip shows.
  useEffect(() => {
    if (threadId && rememberedPermission && !setPermissionMode.isPending) setPermissionMode.mutate({ threadId, mode: rememberedPermission });
  }, [threadId, rememberedPermission]);
  const permissionLabel = (value?: string) => {
    const choice = permissionModes?.choices.find((c) => c.value === value);
    return choice ? permissionName(t, choice) : value;
  };
  const noEngineReady = engines ? !engines.some((e) => e.ok && !e.terminalOnly && conducts(e)) : false;

  // Quick picks: with a thread they are that thread's overrides (what Start chose), layered over the engine's
  // global options — the same knobs settings edits; without one they edit the global options a new thread would get.
  const saveSettings = useSaveSettings();
  const setOptions = useSetOptions(projectId);
  const globalOptions = (agentSettings?.engines?.[currentEngineId] ?? {}) as Record<string, unknown>;
  const threadOptions = (detail?.thread.engine === currentEngineId ? detail.thread.options : null) ?? {};
  const engineOptions = { ...globalOptions, ...threadOptions };
  const picks = engine?.picks ?? [];
  // Only a free-text pick keeps a value outside its choices; elsewhere that is a choice gone (a removed profile), so the default.
  const pickValue = (pick: EnginePick) => {
    const value = engineOptions[pick.key];
    return typeof value === "string" && value && (pick.freeText || pick.choices.some((c) => c.value === value)) ? value : null;
  };
  const setPick = (key: string, value: string | null) => {
    if (threadId) {
      const next = { ...threadOptions } as Record<string, unknown>;
      if (value) next[key] = value;
      else delete next[key];
      setOptions.mutate({ threadId, options: Object.keys(next).length ? next : null });
      return;
    }
    if (!settings || !agentSettings) return;
    const next = { ...globalOptions };
    if (value) next[key] = value;
    else delete next[key];
    saveSettings.mutate({ ...settings, agent: { ...agentSettings, engines: { ...agentSettings.engines, [currentEngineId]: next } } });
  };
  const pickTitle = (pick: EnginePick) =>
    pick.key === "model" || pick.key === "profile" ? t("agentPanel.modelHead") : pick.key === "effort" ? t("agentPanel.effortHead") : pick.title;

  return {
    usable, defaultEngine, currentEngineId, engine, noEngineReady,
    permissionModes, selectedPermissionMode, activePermissionMode, permissionLabel, setPermissionMode,
    threadOptions, engineOptions, picks, pickValue, setPick, pickTitle
  };
}
