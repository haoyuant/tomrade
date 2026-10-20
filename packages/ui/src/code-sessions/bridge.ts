import type { WindowMessage, WindowPost, WindowState } from "@tomradex/code-sessions";

export interface Look {
  theme: string;
  dark: boolean;
  tokens: Record<string, string>;
  locale: string;
}

interface SurfaceBridge {
  onState(listener: (state: unknown) => void): () => void;
  onMessage(listener: (message: unknown) => void): () => void;
  onLook(listener: (look: Look) => void): () => void;
  send(message: unknown): void;
  pathForFile?(file: File): string;
}

declare global {
  interface Window {
    tomradeSurface?: SurfaceBridge;
  }
}

const surface = (): SurfaceBridge | undefined => window.tomradeSurface;

export const send = (message: WindowMessage): void => surface()?.send(message);
export const pathForFile = (file: File): string => surface()?.pathForFile?.(file) ?? "";
export const onState = (listener: (state: WindowState) => void) => surface()?.onState((s) => listener(s as WindowState)) ?? (() => undefined);
export const onLook = (listener: (look: Look) => void) => surface()?.onLook(listener) ?? (() => undefined);

type ShownIn = Extract<WindowPost, { type: "shownIn" }>;
type CellPost = Exclude<Extract<WindowPost, { cell: string }>, ShownIn>;
const cells = new Map<string, (post: CellPost) => void>();
const toasts = new Set<(text: string) => void>();
const shownIn = new Set<(post: ShownIn) => void>();

// One listener for every post: frames and ends go to their cell, toasts to whoever shows them.
surface()?.onMessage((raw) => {
  const post = raw as WindowPost;
  if (post.type === "toast") for (const listener of toasts) listener(post.text);
  else if (post.type === "shownIn") for (const listener of shownIn) listener(post);
  else cells.get(post.cell)?.(post);
});

export function onCell(cell: string, listener: (post: CellPost) => void): () => void {
  cells.set(cell, listener);
  return () => {
    if (cells.get(cell) === listener) cells.delete(cell);
  };
}

/** A cell asked for a pane another cell of the window already streams. */
export function onShownIn(listener: (post: ShownIn) => void): () => void {
  shownIn.add(listener);
  return () => shownIn.delete(listener);
}

export function onToast(listener: (text: string) => void): () => void {
  toasts.add(listener);
  return () => toasts.delete(listener);
}
