import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentEvent, ThreadDetail } from "@tomrade/agent";
import { useEffect } from "react";
import { invoke, subscribe } from "./api";
import { invalidateWorkspace } from "./queries";

export const agentKeys = {
  threads: (projectId: string) => ["agent", "threads", projectId] as const,
  thread: (threadId: string) => ["agent", "thread", threadId] as const,
  engines: ["agent", "engines"] as const,
  playbooks: ["agent", "playbooks"] as const
};

export const useAgentThreads = (projectId: string) => useQuery({ queryKey: agentKeys.threads(projectId), queryFn: () => invoke("agent.threads", projectId) });

export const useAgentThread = (threadId: string | null) =>
  useQuery({ queryKey: agentKeys.thread(threadId ?? ""), queryFn: () => invoke("agent.thread", threadId!), enabled: !!threadId });

export const useEngines = () => useQuery({ queryKey: agentKeys.engines, queryFn: () => invoke("agent.engines"), staleTime: 15_000 });

export function useNewThread(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (engine?: string) => invoke("agent.newThread", projectId, engine),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) })
  });
}

export function useSetEngine(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; engineId: string }) => invoke("agent.setEngine", args.threadId, args.engineId),
    onSuccess: (_thread, args) => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(args.threadId) });
      void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
    }
  });
}

export const useSend = () => useMutation({ mutationFn: (args: { threadId: string; text: string }) => invoke("agent.send", args.threadId, args.text) });
export const useAnswer = () =>
  useMutation({ mutationFn: (args: { threadId: string; questionId: string; value: string | string[] }) => invoke("agent.answer", args.threadId, args.questionId, args.value) });
export const useCancelRun = () => useMutation({ mutationFn: (runId: string) => invoke("agent.cancel", runId) });

export function useRevertRun(projectId: string, threadId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => invoke("agent.revert", runId),
    onSuccess: () => {
      if (threadId) void qc.invalidateQueries({ queryKey: agentKeys.thread(threadId) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

/**
 * The live wire: blocks and deltas land in the query cache as they happen, a
 * finished run refetches, a run that wrote invalidates the board.
 */
export function useAgentEvents(projectId: string, threadId: string | null, onDelta: (runId: string, text: string | null) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribe("agent.event", (eventThreadId: string, event: AgentEvent) => {
      if (eventThreadId !== threadId) {
        void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
        return;
      }
      const key = agentKeys.thread(threadId);
      const patch = (fn: (detail: ThreadDetail) => ThreadDetail) => qc.setQueryData<ThreadDetail>(key, (d) => (d ? fn(d) : d));
      switch (event.type) {
        case "delta":
          onDelta(event.runId, event.text);
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
          break;
        case "done":
          onDelta(event.run.id, null);
          void qc.invalidateQueries({ queryKey: key });
          void qc.invalidateQueries({ queryKey: agentKeys.threads(projectId) });
          if (event.run.changes > 0) invalidateWorkspace(qc, projectId);
          break;
      }
    });
  }, [projectId, threadId, qc, onDelta]);
}
