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
}

declare global {
  interface Window {
    tomradeSurface?: SurfaceBridge;
  }
}

const surface = (): SurfaceBridge | undefined => window.tomradeSurface;

export const send = (message: WindowMessage): void => surface()?.send(message);
export const onState = (listener: (state: WindowState) => void) => surface()?.onState((s) => listener(s as WindowState)) ?? (() => undefined);
export const onLook = (listener: (look: Look) => void) => surface()?.onLook(listener) ?? (() => undefined);

type CellPost = Extract<WindowPost, { cell: string }>;
const cells = new Map<string, (post: CellPost) => void>();
const toasts = new Set<(text: string) => void>();

// One listener for every post: frames and ends go to their cell, toasts to whoever shows them.
surface()?.onMessage((raw) => {
  const post = raw as WindowPost;
  if (post.type === "toast") for (const listener of toasts) listener(post.text);
  else cells.get(post.cell)?.(post);
});

export function onCell(cell: string, listener: (post: CellPost) => void): () => void {
  cells.set(cell, listener);
  return () => {
    if (cells.get(cell) === listener) cells.delete(cell);
  };
}

export function onToast(listener: (text: string) => void): () => void {
  toasts.add(listener);
  return () => toasts.delete(listener);
}
