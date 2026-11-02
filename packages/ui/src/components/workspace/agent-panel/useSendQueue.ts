import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EngineView, RunView, ThreadMessage } from "@tomradex/agent";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";
import type { Queued } from "./blocks";

/**
 * Messages written while a run works: queued per thread, in memory, to go out once a turn ends
 * well — or sent into the running turn when the engine steers.
 */
export function useSendQueue({ projectId, threadId, engine, currentEngineId, runningRun, messages, busy, held, caughtUp, sending, doSend, steerFiles }: {
  projectId: string;
  threadId: string | null;
  engine: EngineView | undefined;
  currentEngineId: string;
  runningRun: RunView | undefined;
  messages: ThreadMessage[] | undefined;
  busy: boolean;
  /** A stop, a failure or a question holds what waits. */
  held: boolean;
  /** Whether the thread already shows the run the last send started. */
  caughtUp: boolean;
  sending: RefObject<boolean>;
  doSend: (text: string, queued: Queued) => Promise<boolean>;
  /** Into the running turn with what it attaches, uploaded first; false means it was not taken. */
  steerFiles: (inThread: string, entry: Queued) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  // Per thread, in memory: what waits for the running turn to end.
  const [queues, setQueues] = useState<Record<string, Queued[]>>({});
  const queue = useMemo(() => (threadId ? (queues[threadId] ?? []) : []), [threadId, queues]);
  const editQueue = (id: string, fn: (q: Queued[]) => Queued[]) => setQueues((prev) => ({ ...prev, [id]: fn(prev[id] ?? []) }));
  // Sent into the running turn and not yet read by the agent; whatever the turn ends without reading joins the queue.
  const [steering, setSteering] = useState<Record<string, Queued[]>>({});
  const steeringNow = useMemo(() => (threadId ? (steering[threadId] ?? []) : []), [threadId, steering]);

  const steer = async (inThread: string, entry: Queued) => {
    const taken = !!engine?.steers && await (entry.attachments?.length ? steerFiles(inThread, entry) : invoke("agent.steer", projectId, inThread, entry.id, entry.text)).catch(() => false);
    if (taken) {
      setSteering((prev) => ({ ...prev, [inThread]: [...(prev[inThread] ?? []), entry] }));
      editQueue(inThread, (q) => q.filter((x) => x.id !== entry.id));
      return;
    }
    if (!(queues[inThread] ?? []).some((x) => x.id === entry.id)) editQueue(inThread, (q) => [...q, entry]);
    toast({ body: t(entry.attachments?.length && engine?.steers ? "agentPanel.steerFilesQueued" : "agentPanel.steerQueued", { name: engine?.title ?? currentEngineId }) });
  };
  const steeredIds = useMemo(() => new Set((messages ?? []).flatMap((m) => (m.block.type === "text" && m.block.steerId ? [m.block.steerId] : []))), [messages]);
  useEffect(() => {
    if (!threadId || !steeringNow.length) return;
    const left = steeringNow.filter((s) => !steeredIds.has(s.id));
    if (runningRun) {
      if (left.length !== steeringNow.length) setSteering((prev) => ({ ...prev, [threadId]: left }));
      return;
    }
    setSteering((prev) => ({ ...prev, [threadId]: [] }));
    if (left.length) editQueue(threadId, (q) => [...left, ...q]);
  }, [threadId, steeringNow, steeredIds, runningRun]);

  const sendQueued = async (inThread: string, entry: Queued) => {
    editQueue(inThread, (q) => q.filter((x) => x.id !== entry.id));
    // a send that did not go keeps its place at the head, for the person to try again
    if (!(await doSend(entry.text, entry))) editQueue(inThread, (q) => [{ ...entry, stuck: true }, ...q.filter((x) => x.id !== entry.id)]);
  };
  const sendQueuedRef = useRef(sendQueued);
  sendQueuedRef.current = sendQueued;
  // Waiting messages go on only after a turn that ended well.
  useEffect(() => {
    if (!threadId || !queue.length || queue[0].stuck || busy || held || !caughtUp || sending.current) return;
    void sendQueuedRef.current(threadId, queue[0]);
  }, [threadId, queue, busy, held, caughtUp, sending]);

  return { queue, steeringNow, editQueue, steer, sendQueued };
}
