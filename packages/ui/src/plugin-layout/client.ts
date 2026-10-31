import type { LayoutApi, LayoutState, LayoutStateKey } from "@tomradex/plugin-sdk";
import { CONNECT, applyItems, type ConnectMessage, type FrameCall, type FrameMessage, type HostMessage } from "./protocol";

/**
 * The frame's end of the port: the api a sandboxed layout is mounted with.
 * State arrives whole once and then as deltas, rebuilt so an unchanged ticket
 * keeps its object; calls go up by id and resolve when the window answers.
 */
export function clientApi(port: MessagePort, initial: LayoutState): LayoutApi {
  let state = initial;
  let nextId = 1;
  const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const listeners = new Set<(state: LayoutState, changed: ReadonlySet<LayoutStateKey>) => void>();
  const post = (message: FrameMessage) => port.postMessage(message);
  const call = (call: FrameCall) =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      post({ type: "call", id, ...call });
    });
  port.onmessage = (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (message.type === "result") {
      const w = waiting.get(message.id);
      waiting.delete(message.id);
      if (!w) return;
      if (message.error) w.reject(new Error(message.error));
      else w.resolve();
      return;
    }
    if (message.type !== "change") return;
    state = { ...state, ...message.patch, ...(message.items ? { items: applyItems(state.items, message.items) } : {}) };
    const changed = new Set(message.changed);
    for (const listener of listeners) listener(state, changed);
  };
  port.start();
  return {
    get state() {
      return state;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    select: (id) => call({ method: "select", args: [id] }),
    update: (id, patch) => call({ method: "update", args: [id, patch] })
  };
}

/** Waits for the window's connect message: the port, the module to import and the first state. */
export function awaitConnect(target: Window): Promise<{ port: MessagePort; module: string; state: LayoutState }> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<ConnectMessage>) => {
      const port = event.ports[0];
      if (!event.data || event.data.type !== CONNECT || !port) return;
      target.removeEventListener("message", onMessage);
      resolve({ port, module: event.data.module, state: event.data.state });
    };
    target.addEventListener("message", onMessage);
  });
}
