import { useCallback, useState } from "react";
import { isDetachedWindow } from "./window-chrome";

/**
 * A side pane's open state, remembered per machine. Every toggle persists —
 * the shortcut and the palette as much as the pane's own buttons. A window a
 * tab moved into keeps its own, starting as the machine's or as `detached` says.
 */
export function usePanelOpen(key: string, opts?: { detached?: boolean }) {
  const [open, setState] = useState(() => {
    const detached = isDetachedWindow();
    const own = (detached ? sessionStorage : localStorage).getItem(key);
    if (own !== null) return own !== "0";
    return detached && opts?.detached !== undefined ? opts.detached : localStorage.getItem(key) !== "0";
  });
  const setOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        (isDetachedWindow() ? sessionStorage : localStorage).setItem(key, value ? "1" : "0");
        return value;
      });
    },
    [key]
  );
  return [open, setOpen] as const;
}
