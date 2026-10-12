import { useEffect, useRef } from "react";

type Opener = (pane: string) => void;

// The one registered last is the one on show.
const hosts: Opener[] = [];
const sheets: Opener[] = [];

function useRegistered(list: Opener[], fn: Opener, active = true): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry: Opener = (pane) => latest.current(pane);
    list.push(entry);
    return () => {
      list.splice(list.indexOf(entry), 1);
    };
  }, [list, active]);
}

/** Mounted by a screen that hosts the Settings sheet, so the root can open it on a pane. */
export const useSettingsHost = (open: Opener) => useRegistered(hosts, open);

/** Mounted by the Settings sheet: while it is open, a request turns it to the pane instead of opening another. */
export const useSettingsSheet = (open: boolean, go: Opener) => useRegistered(sheets, go, open);

/** Shows Settings on `pane` — the open sheet, else the screen's. False when nothing can show it. */
export function openSettingsPane(pane: string): boolean {
  const target = sheets.at(-1) ?? hosts.at(-1);
  target?.(pane);
  return !!target;
}
