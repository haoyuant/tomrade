import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentEvent, AgentSettings, EngineView, FocusRef, MediaRef, PlaybookIndexEntry, PlaybookSource, ThreadDetail } from "@tomradex/agent";
import type { WorkType } from "@tomradex/domain";
import { useEffect, useRef } from "react";
import { invoke, subscribe } from "./api";
import { useI18n, type MessageKey } from "./i18n";
import { invalidateWorkspace, keys, useSaveSettings, useSettings } from "./queries";
import { useToast } from "./toast";
import { useErrorToast } from "~/lib/toast";

export const agentKeys = {
  threads: (projectId: string) => ["agent", "threads", projectId] as const,
  thread: (projectId: string, threadId: string) => ["agent", "thread", projectId, threadId] as const,
  engines: ["agent", "engines"] as const,
  playbooks: (projectId?: string) => ["agent", "playbooks", projectId ?? ""] as const,
  workdir: (projectId: string, threadId: string) => ["agent", "workdir", projectId, threadId] as const
};

export const useAgentThreads = (projectId: string) => useQuery({ queryKey: agentKeys.threads(projectId), queryFn: () => invoke("agent.threads", projectId) });

/** Put-away conversations, fetched only while the list asks for them. */
export const useArchivedThreads = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: [...agentKeys.threads(projectId), "archived"], queryFn: () => invoke("agent.archivedThreads", projectId), enabled });

export function useUnarchiveThread(projectId: string) {
  const qc = useQueryClient();
  const report = useErrorToast();
  return useMutation({
    onError: report,
    mutationFn: (threadId: string) => invoke("agent.unarchiveThread", projectId, threadId),
    onSuccess: (_ok, threadId) => {
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
      void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, threadId) });
    }
  });
}

// Events only patch the thread on screen, so a cached one missed whatever its run did meanwhile
// (even finishing, which left the panel "working" for good): always refetch when it comes back into view.
export const useAgentThread = (projectId: string, threadId: string | null) =>
  useQuery({ queryKey: agentKeys.thread(projectId, threadId ?? ""), queryFn: () => invoke("agent.thread", projectId, threadId!), enabled: !!threadId, staleTime: 0 });

/**
 * The playbooks a ticket of this work type can run as its method — the built-in
 * ones and whatever the user or the project adds. Backlog and code playbooks are
 * the assistant's own and the code-link's, never a ticket's method.
 */
// A built-in playbook that names no work type steers the assistant (app.guide, studio.build-plugin); it is no method for a ticket.
export const ticketMethods = (playbooks: readonly PlaybookIndexEntry[] | undefined, workType: WorkType): PlaybookIndexEntry[] =>
  (playbooks ?? [])
    .filter((playbook) => !playbook.id.startsWith("backlog.") && !playbook.id.startsWith("code.") && (playbook.workTypes?.length ? playbook.workTypes.includes(workType) : playbook.source !== "plugin"))
    .sort((a, b) => Number(!!b.workTypes?.includes(workType)) - Number(!!a.workTypes?.includes(workType)) || a.title.localeCompare(b.title));

const BUILT_IN_METHODS: Record<string, [MessageKey, MessageKey]> = {
  "task.assist": ["fields.manualTemplate", "playbooks.methodAssistWhen"],
  "document.write": ["fields.documentTemplate", "playbooks.methodDocumentWhen"],
  "design.create": ["fields.designTemplate", "playbooks.methodDesignWhen"],
  "media.generate": ["fields.mediaTemplate", "playbooks.methodMediaWhen"]
};

/** A method's name and what it does: the person's language for the built-in ones, a playbook's own words for anything else. */
export const methodWords = (t: (key: MessageKey) => string, id: string, entry?: Pick<PlaybookIndexEntry, "title" | "when" | "source">): { title: string; when: string } => {
  const words = !entry || entry.source === "plugin" ? BUILT_IN_METHODS[id] : undefined;
  return words ? { title: t(words[0]), when: t(words[1]) } : { title: entry?.title ?? id, when: entry?.when ?? "" };
};

export const useEngines = () => useQuery({ queryKey: agentKeys.engines, queryFn: () => invoke("agent.engines"), staleTime: 15_000 });

/** The engine answering for an id a thread, run or setting holds — itself, or the engine that took it in. */
export const findEngine = (engines: EngineView[] | undefined, id: string | null | undefined): EngineView | undefined =>
  id ? (engines?.find((e) => e.id === id) ?? engines?.find((e) => e.includes?.includes(id))) : undefined;

/** An engine with no capabilities conducts only the threads its plugin opens — the troubleshooter's: no list offers it. */
export const conducts = (engine: Pick<EngineView, "capabilities">): boolean => engine.capabilities.length > 0;

export const usePlaybooks = (projectId?: string) =>
  useQuery({ queryKey: agentKeys.playbooks(projectId), queryFn: () => invoke("agent.playbooks", projectId), staleTime: 15_000 });

const EMPTY_AGENT_SETTINGS: AgentSettings = { defaultEngine: "tomrade", confirmWritesOver: 0, resumeAfterLimit: true, engines: {}, playbookChoices: {} };

/**
 * Surfaces playbook id collisions the user has not ruled on: one toast per id,
 * naming the version in effect, with a button per version. Picking one records
 * it in settings.agent.playbookChoices; plain dismissal asks again next visit.
 */
export function usePlaybookConflictNotice(projectId: string): void {
  const playbooks = usePlaybooks(projectId);
  const settings = useSettings();
  const save = useSaveSettings();
  const toast = useToast();
  const { t } = useI18n();
  const qc = useQueryClient();
  const noticed = useRef(new Set<string>());

  useEffect(() => {
    const entries = playbooks.data;
    const app = settings.data;
    if (!entries || !app) return;
    const agent = (app.agent as AgentSettings | undefined) ?? EMPTY_AGENT_SETTINGS;
    const sourceLabel: Record<PlaybookSource, string> = {
      plugin: t("playbooks.sourcePlugin"),
      user: t("playbooks.sourceUser"),
      project: t("playbooks.sourceProject")
    };
    const record = (id: string, source: PlaybookSource) =>
      save.mutate(
        { ...app, agent: { ...agent, playbookChoices: { ...agent.playbookChoices, [id]: source } } },
        { onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "playbooks"] }) }
      );
    for (const entry of entries) {
      if (!entry.shadows.length || agent.playbookChoices?.[entry.id] || noticed.current.has(entry.id)) continue;
      noticed.current.add(entry.id);
      toast({
        body: t("playbooks.conflictBody", { title: entry.title, source: sourceLabel[entry.source] }),
        actions: [
          { label: t("playbooks.keepCurrent"), run: () => record(entry.id, entry.source) },
          ...entry.shadows.map((s) => ({ label: t("playbooks.useSource", { source: sourceLabel[s] }), run: () => record(entry.id, s) }))
        ]
      });
    }
  }, [playbooks.data, settings.data, save, toast, t, qc]);
}

export function useNewThread(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { engine?: string; boardId?: string | null; options?: Record<string, unknown> | null } = {}) =>
      invoke("agent.newThread", projectId, args.engine, args.boardId ?? null, { options: args.options }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) })
  });
}

/** Put the thread on a workstream — and so in that workstream's repository — or back on the whole project. */
export function useSetWorkstream(projectId: string) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (args: { threadId: string; boardId: string | null }) => invoke("agent.setWorkstream", projectId, args.threadId, args.boardId),
    onSuccess: (_thread, args) => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, args.threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
      void qc.invalidateQueries({ queryKey: agentKeys.workdir(projectId, args.threadId) });
    }
  });
}

export function useArchiveThread(projectId: string) {
  const qc = useQueryClient();
  const report = useErrorToast();
  return useMutation({ onError: report, mutationFn: (threadId: string) => invoke("agent.archiveThread", projectId, threadId), onSuccess: () => void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) }) });
}

export function useDeleteThread(projectId: string) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (threadId: string) => invoke("agent.deleteThread", projectId, threadId),
    onSuccess: (_deleted, threadId) => {
      qc.setQueryData(agentKeys.threads(projectId), (threads: { id: string }[] | undefined) => threads?.filter((thread) => thread.id !== threadId));
      qc.removeQueries({ queryKey: agentKeys.thread(projectId, threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
    }
  });
}

/** Where the thread's engine would run, or why it cannot yet (no checkout of the workstream's repository here). */
export const useWorkdir = (projectId: string, threadId: string | null, enabled = true) =>
  useQuery({ queryKey: agentKeys.workdir(projectId, threadId ?? ""), queryFn: () => invoke("agent.workdir", projectId, threadId!), enabled: !!threadId && enabled, retry: false, staleTime: 5_000 });

export function useSetEngine(projectId: string) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (args: { threadId: string; engineId: string }) => invoke("agent.setEngine", projectId, args.threadId, args.engineId),
    onSuccess: (_thread, args) => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, args.threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
    }
  });
}

/** Engine knobs for one thread — model, effort — layered over the engine's settings; null clears them. */
export function useSetOptions(projectId: string) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (args: { threadId: string; options: Record<string, unknown> | null }) => invoke("agent.setOptions", projectId, args.threadId, args.options),
    onSuccess: (_thread, args) => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, args.threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
    }
  });
}

export function useSetPermissionMode(projectId: string) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (args: { threadId: string; mode: string }) => invoke("agent.setPermissionMode", projectId, args.threadId, args.mode),
    onSuccess: (_thread, args) => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, args.threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
    }
  });
}

export const useSend = (projectId: string) =>
  useMutation({ mutationFn: (args: { threadId: string; text: string; focus?: FocusRef[]; attachments?: MediaRef[] }) => invoke("agent.send", projectId, args.threadId, args.text, args.focus, args.attachments) });
// An answer to a question that expired, or a Stop that did not land, says so rather than doing nothing.
export function useAnswer(projectId: string) {
  const report = useErrorToast();
  return useMutation({ onError: report, mutationFn: (args: { threadId: string; questionId: string; value: string | string[] }) => invoke("agent.answer", projectId, args.threadId, args.questionId, args.value) });
}
export function useCancelRun() {
  const report = useErrorToast();
  return useMutation({ onError: report, mutationFn: (runId: string) => invoke("agent.cancel", runId) });
}

export function useRevertRun(projectId: string, threadId: string | null) {
  const report = useErrorToast();
  const qc = useQueryClient();
  return useMutation({
    onError: report,
    mutationFn: (runId: string) => invoke("agent.revert", projectId, runId),
    onSuccess: () => {
      if (threadId) void qc.invalidateQueries({ queryKey: agentKeys.thread(projectId, threadId) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

/**
 * The live wire: blocks and deltas land in the query cache as they happen, a
 * finished run refetches, a run that wrote invalidates the board.
 */
export interface RunProgress {
  runId: string;
  /** Undefined: the event did not say; null: nothing is running. */
  activity?: string | null;
  retry?: Extract<AgentEvent, { type: "progress" }>["retry"];
  usage: { inputTokens: number; outputTokens: number } | null;
  elapsedMs?: number;
  metrics?: ThreadDetail["runs"][number]["metrics"];
}

export function useAgentEvents(
  projectId: string,
  threadId: string | null,
  onDelta: (runId: string, text: string | null) => void,
  onProgress: (progress: RunProgress | null) => void
): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribe("agent.event", (eventThreadId: string, event: AgentEvent) => {
      if (eventThreadId !== threadId) {
        // another conversation's list entry changes when a run starts or ends, or a message lands — not per streamed word
        if (event.type === "run" || event.type === "done" || event.type === "message") void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
        // a ticket's spend is read with its items
        if (event.type === "done" && event.run.costUsd) void qc.invalidateQueries({ queryKey: keys.items(projectId) });
        return;
      }
      const key = agentKeys.thread(projectId, threadId);
      const patch = (fn: (detail: ThreadDetail) => ThreadDetail) => qc.setQueryData<ThreadDetail>(key, (d) => (d ? fn(d) : d));
      switch (event.type) {
        case "permission-mode":
          patch((d) => ({ ...d, activePermissionMode: event.mode }));
          break;
        case "delta":
          onDelta(event.runId, event.text);
          break;
        case "progress":
          onProgress({ runId: event.runId, activity: event.activity, retry: event.retry, usage: event.usage ?? null, elapsedMs: event.elapsedMs, metrics: event.metrics });
          break;
        case "message":
          if (event.message.block.type === "text" && event.message.role === "agent") onDelta(event.message.runId ?? "", null);
          patch((d) => (d.messages.some((m) => m.id === event.message.id) ? d : { ...d, messages: [...d.messages, event.message] }));
          break;
        case "card":
          patch((d) => ({ ...d, cards: [...d.cards.filter((c) => c.id !== event.card.id), event.card] }));
          break;
        case "pending":
          patch((d) => ({ ...d, pending: event.pending }));
          break;
        case "run":
          patch((d) => ({ ...d, runs: [...d.runs.filter((r) => r.id !== event.run.id), event.run] }));
          // the thread list says which conversations are running
          void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId), exact: true });
          break;
        case "done":
          onDelta(event.run.id, null);
          onProgress(null);
          void qc.invalidateQueries({ queryKey: key });
          void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
          if (event.run.changes > 0) invalidateWorkspace(qc, projectId);
          else if (event.run.costUsd) void qc.invalidateQueries({ queryKey: keys.items(projectId) });
          break;
      }
    });
  }, [projectId, threadId, qc, onDelta, onProgress]);
}
