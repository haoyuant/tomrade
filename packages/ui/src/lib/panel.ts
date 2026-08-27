import { useCallback, useState } from "react";

/**
 * A side pane's open state, remembered per machine. Every toggle persists —
 * the shortcut and the palette as much as the pane's own buttons.
 */
export function usePanelOpen(key: string) {
  const [open, setState] = useState(() => localStorage.getItem(key) !== "0");
  const setOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        localStorage.setItem(key, value ? "1" : "0");
        return value;
      });
    },
    [key]
  );
  return [open, setOpen] as const;
}
