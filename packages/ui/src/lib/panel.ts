import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { swapPanels } from "./motion";
import { isDetachedWindow } from "./window-chrome";

/**
 * A side pane's open state, remembered per machine. Every toggle persists —
 * the shortcut and the palette as much as the pane's own buttons. A window a
 * tab moved into keeps its own, starting as the machine's or as `detached` says.
 * With `swap`, the pane is a whole panel and opens and closes as a view transition.
 */
export function usePanelOpen(key: string, opts?: { detached?: boolean; swap?: boolean }) {
  const [open, setState] = useState(() => {
    const detached = isDetachedWindow();
    const own = (detached ? sessionStorage : localStorage).getItem(key);
    if (own !== null) return own !== "0";
    return detached && opts?.detached !== undefined ? opts.detached : localStorage.getItem(key) !== "0";
  });
  // What the pane is becoming, ahead of a swap that lands a frame later; toggles read it rather than the render.
  const becoming = useRef(open);
  useLayoutEffect(() => { becoming.current = open; }, [open]);
  const swap = opts?.swap ?? false;
  const setOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(becoming.current) : next;
      if (value === becoming.current) return;
      becoming.current = value;
      const apply = () => {
        (isDetachedWindow() ? sessionStorage : localStorage).setItem(key, value ? "1" : "0");
        setState(value);
      };
      if (swap) swapPanels(apply);
      else apply();
    },
    [key, swap]
  );
  return [open, setOpen] as const;
}
