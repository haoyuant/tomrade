import { useRef } from "react";
import { STORE } from "./store";

const HISTORY_CAP = 100;

/** What the person sent in this project, oldest first: ↑ in the composer walks back through it. */
const readHistory = (projectId: string): string[] => {
  try {
    const list = JSON.parse(localStorage.getItem(STORE.history(projectId)) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
const remember = (projectId: string, text: string) => {
  const list = readHistory(projectId);
  if (list[list.length - 1] === text) return;
  localStorage.setItem(STORE.history(projectId), JSON.stringify([...list, text].slice(-HISTORY_CAP)));
};

export function useComposerHistory(projectId: string, draft: string, setDraft: (text: string) => void) {
  // Where ↑/↓ stands in the history (null: not browsing) and the draft it set aside.
  const browsing = useRef<{ at: number; stash: string } | null>(null);

  /** ↑ on the first line steps back through what was sent, ↓ on the last line forward, past the newest back to the draft. */
  const recall = (el: HTMLTextAreaElement, step: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false;
    const value = el.value;
    if (step < 0 ? value.slice(0, el.selectionStart).includes("\n") : value.slice(el.selectionEnd).includes("\n")) return false;
    const list = readHistory(projectId);
    const now = browsing.current;
    if (step < 0 && !list.length) return false;
    if (step > 0 && !now) return false;
    const at = now ? now.at + step : list.length - 1;
    if (at < 0) return true;
    const stash = now?.stash ?? draft;
    const text = at >= list.length ? stash : list[at];
    browsing.current = at >= list.length ? null : { at, stash };
    setDraft(text);
    requestAnimationFrame(() => el.setSelectionRange(text.length, text.length));
    return true;
  };

  return {
    recall,
    stopBrowsing: () => { browsing.current = null; },
    remember: (text: string) => remember(projectId, text)
  };
}
