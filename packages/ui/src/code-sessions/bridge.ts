import type { ReviewCursor } from "@tomradex/code-link";
import type { WindowMessage, WindowPost, WindowState } from "@tomradex/code-sessions";

export interface Look {
  theme: string;
  dark: boolean;
  tokens: Record<string, string>;
  locale: string;
  /** The shell put the system's frosted material under this window: the page leaves its own background off. */
  frosted?: boolean;
  backdrop?: { veil: number; frost: number; terminalVeil?: number };
  /** On this page only: something is behind the window (the system's material or the theme's picture), so terminals draw no background of their own. */
  clear?: boolean;
}

interface SurfaceBridge {
  onState(listener: (state: unknown) => void): () => void;
  onMessage(listener: (message: unknown) => void): () => void;
  onLook(listener: (look: Look) => void): () => void;
  send(message: unknown): void;
  pathForFile?(file: File): string;
  pickDirectory?(title: string, buttonLabel: string): Promise<string | null>;
  terminalPicture?(themeId: string): Promise<{ mime: string; base64: string } | null>;
}

declare global {
  interface Window {
    tomradeSurface?: SurfaceBridge;
  }
}

const surface = (): SurfaceBridge | undefined => window.tomradeSurface;

export const send = (message: WindowMessage): void => surface()?.send(message);
export const pickDirectory = (title: string, buttonLabel: string): Promise<string | null> => (surface()?.pickDirectory?.(title, buttonLabel) ?? Promise.resolve(null)).catch(() => null);
export const pathForFile = (file: File): string => surface()?.pathForFile?.(file) ?? "";
export const terminalPicture = (themeId: string) => (surface()?.terminalPicture?.(themeId) ?? Promise.resolve(null)).catch(() => null);
export const onState = (listener: (state: WindowState) => void) => surface()?.onState((s) => listener(s as WindowState)) ?? (() => undefined);
export const onLook = (listener: (look: Look) => void) => surface()?.onLook(listener) ?? (() => undefined);

type ShownIn = Extract<WindowPost, { type: "shownIn" }>;
type Tails = Extract<WindowPost, { type: "tails" }>;
type HistoryPage = Extract<WindowPost, { type: "historyPage" }>;
type HistorySaid = Extract<WindowPost, { type: "historySaid" }>;
type Reviewed = Extract<WindowPost, { type: "reviewFound" }>;
type CellPost = Exclude<Extract<WindowPost, { cell: string }>, ShownIn>;
const cells = new Map<string, Set<(post: CellPost) => void>>();
const toasts = new Set<(text: string) => void>();
const shownIn = new Set<(post: ShownIn) => void>();
const tails = new Set<(post: Tails) => void>();
const historyChanged = new Set<() => void>();
/** Each History ask, by its token, waiting for its answer. */
const answers = new Map<number, (post: HistoryPage | HistorySaid) => void>();
/** Each card's answer on its way, by its token. */
const answering = new Map<number, () => void>();
let tokens = 0;
const reviewed = new Set<(post: Reviewed) => void>();

// One listener for every post: frames and ends go to their cell, toasts to whoever shows them, History's answers to their ask.
surface()?.onMessage((raw) => {
  const post = raw as WindowPost;
  if (post.type === "toast") for (const listener of toasts) listener(post.text);
  else if (post.type === "answered") {
    answering.get(post.token)?.();
    answering.delete(post.token);
  }
  else if (post.type === "shownIn") for (const listener of shownIn) listener(post);
  else if (post.type === "tails") for (const listener of tails) listener(post);
  else if (post.type === "historyPage" || post.type === "historySaid") {
    answers.get(post.token)?.(post);
    answers.delete(post.token);
  } else if (post.type === "historyChanged") for (const listener of historyChanged) listener();
  else if (post.type === "reviewFound") for (const listener of reviewed) listener(post);
  else for (const listener of cells.get(post.cell) ?? []) listener(post);
});

/** An ask the plugin answers once, by token. */
function ask<T extends HistoryPage | HistorySaid>(message: (token: number) => WindowMessage): Promise<T> {
  return new Promise((resolve) => {
    const token = ++tokens;
    answers.set(token, (post) => resolve(post as T));
    send(message(token));
  });
}

/** How long a card waits on an answer that never says it went before its buttons work again. */
const ANSWER_GIVE_UP_MS = 15_000;

/** A card's answer, settled once the plugin says it went or failed to. */
function answer(message: (token: number) => WindowMessage): Promise<void> {
  return new Promise((resolve) => {
    const token = ++tokens;
    const done = () => {
      clearTimeout(timer);
      answering.delete(token);
      resolve();
    };
    const timer = setTimeout(done, ANSWER_GIVE_UP_MS);
    answering.set(token, done);
    send(message(token));
  });
}

/** A terminal session's prompt allowed or denied from its card. */
export const answerSession = (sessionId: string, which: "allow" | "deny"): Promise<void> => answer((token) => ({ type: "answer", sessionId, which, token }));

/** An assistant conversation's question answered from its card. */
export const answerThreadAsk = (threadId: string, questionId: string, value: string): Promise<void> => answer((token) => ({ type: "answerThread", threadId, questionId, value, token }));

/** One page of History: the newest, the one past `before`, or the newest matches of `query`. */
export const historyList = (opts: { before?: ReviewCursor | null; query?: string }): Promise<HistoryPage> => ask((token) => ({ type: "historyList", token, ...opts }));

/** The ended conversations that said this, from their agents' records. */
export const historySaid = (query: string): Promise<HistorySaid> => ask((token) => ({ type: "historySaid", token, query }));

/** A session ended or a conversation moved while History is open. */
export function onHistoryChanged(listener: () => void): () => void {
  historyChanged.add(listener);
  return () => historyChanged.delete(listener);
}

/** A cell's posts; a cell may listen from more than one place (its conversation and its replay). */
export function onCell(cell: string, listener: (post: CellPost) => void): () => void {
  const listeners = cells.get(cell) ?? new Set();
  listeners.add(listener);
  cells.set(cell, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && cells.get(cell) === listeners) cells.delete(cell);
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

/** The last lines of the panes the window lists, for the overview. */
export function onTails(listener: (post: Tails) => void): () => void {
  tails.add(listener);
  return () => tails.delete(listener);
}

/** What the look back found for ⌘K's history. */
export function onReviewFound(listener: (post: Reviewed) => void): () => void {
  reviewed.add(listener);
  return () => reviewed.delete(listener);
}
