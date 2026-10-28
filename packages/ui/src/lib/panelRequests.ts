import { useSyncExternalStore } from "react";

/** What another part of the window asks the assistant panel to do: ⌘K's sessions and actions. */
export type PanelRequest =
  | { kind: "newThread" }
  /** A new conversation, sent these words at once. */
  | { kind: "startWith"; text: string }
  /** These words in the input, not sent: in this conversation while it is empty, else a new one. */
  | { kind: "fill"; text: string }
  /** `say`: with the keyboard in its input, to say something to it. */
  | { kind: "openSession"; sessionId: string; say?: boolean }
  | { kind: "toggleBar" }
  | { kind: "nextWaiting" }
  /** The look back on ended conversations: its list, or one of them opened — only `itemId`'s stretches when given. */
  | { kind: "review"; sessionId?: string; threadId?: string; itemId?: string };

const requests = new Set<(request: PanelRequest) => void>();

/** Asks the panel; it answers whether it is open or folded, so open it first when the answer should be seen. */
export const askPanel = (request: PanelRequest): void => {
  for (const listener of requests) listener(request);
};

export function onPanelRequest(listener: (request: PanelRequest) => void): () => void {
  requests.add(listener);
  return () => requests.delete(listener);
}

/** ⌘K opened from elsewhere on its ways to start a new session (the session bar's +). */
const paletteRequests = new Set<() => void>();

/** Whether a palette was there to open; without one the caller starts a conversation itself. */
export function askStartPalette(): boolean {
  for (const listener of paletteRequests) listener();
  return paletteRequests.size > 0;
}

export function onStartPalette(listener: () => void): () => void {
  paletteRequests.add(listener);
  return () => paletteRequests.delete(listener);
}

/** The terminal session the panel shows in place of a thread, if any: what "this session" means to ⌘K. */
let shown: { projectId: string; sessionId: string } | null = null;
const shownListeners = new Set<() => void>();

export function setPanelSession(next: { projectId: string; sessionId: string } | null): void {
  if (shown?.projectId === next?.projectId && shown?.sessionId === next?.sessionId) return;
  shown = next;
  for (const listener of shownListeners) listener();
}

export const usePanelSession = (projectId: string): string | null =>
  useSyncExternalStore(
    (listener) => {
      shownListeners.add(listener);
      return () => shownListeners.delete(listener);
    },
    () => (shown?.projectId === projectId ? shown.sessionId : null)
  );
