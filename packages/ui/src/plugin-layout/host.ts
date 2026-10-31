import type { Patch } from "@tomradex/domain";
import type { LayoutApi, LayoutState, LayoutStateKey } from "@tomradex/plugin-sdk";
import type { LayoutFeed } from "./feed";
import { diffItems, type FrameMessage, type HostMessage } from "./protocol";

/** What a layout may ask of the window, answered by the workspace's own mutations. */
export interface LayoutActions {
  select(id: string | null): Promise<void>;
  update(id: string, patch: Patch): Promise<void>;
}

/** The api a native layout holds: the feed's state as it is, no copy, listeners called in this window. */
export function nativeApi(feed: LayoutFeed, actions: LayoutActions): LayoutApi {
  return {
    get state() {
      return feed.state;
    },
    onChange: (listener) => feed.listen(listener),
    select: (id) => actions.select(id),
    update: (id, patch) => actions.update(id, patch)
  };
}

/**
 * The window's end of a sandboxed layout's port: each coalesced change crosses
 * as the keys that moved, tickets as a delta, and the frame's calls come back
 * answered by id. Returns what stops it.
 */
export function serveFrame(feed: LayoutFeed, port: MessagePort, actions: LayoutActions, onError: (message: string) => void): () => void {
  let sent: LayoutState = feed.state;
  const post = (message: HostMessage, transfer?: Transferable[]) => port.postMessage(message, transfer ?? []);
  const stop = feed.listen((state, changed) => {
    const patch: Partial<Omit<LayoutState, "items">> = {};
    for (const key of changed) if (key !== "items") (patch as Record<string, unknown>)[key] = state[key];
    post({ type: "change", changed: [...changed] as LayoutStateKey[], ...(changed.has("items") ? { items: diffItems(sent.items, state.items) } : {}), patch });
    sent = state;
  });
  port.onmessage = (event: MessageEvent<FrameMessage>) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "error") onError(message.message);
    if (message.type !== "call") return;
    const run = message.method === "select" ? actions.select(...message.args) : actions.update(...message.args);
    run.then(
      () => post({ type: "result", id: message.id }),
      (error: unknown) => post({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) })
    );
  };
  port.start();
  return () => {
    stop();
    port.onmessage = null;
    port.close();
  };
}
