import { useSyncExternalStore } from "react";

let lead = !window.tomrade?.window?.detached;
const leadListeners = new Set<() => void>();

/**
 * `hiddenInset` gives the header the whole window and puts the traffic lights
 * on top of its left edge — but only while windowed. The shell says which, and
 * `--traffic-inset` reads it off <html>. No shell (a browser tab) means no gutter.
 * The same word says whether this window leads.
 */
export function watchWindowChrome(): void {
  window.tomrade?.on?.("window.chrome", ({ trafficLights, lead: next, frosted, softwareCompositing }) => {
    document.documentElement.dataset.trafficLights = trafficLights ? "on" : "off";
    document.documentElement.toggleAttribute("data-frosted", !!frosted);
    document.documentElement.toggleAttribute("data-software-compositing", !!softwareCompositing);
    if (typeof next === "boolean" && next !== lead) {
      lead = next;
      for (const listener of leadListeners) listener();
    }
  });
}

/**
 * `data-window-idle` on <html> while the window is hidden or another window has the focus, so ambient motion pauses
 * instead of drawing frames nobody is watching. Focus that moves into a frame of this page is still this window's.
 */
export function watchWindowAttention(): void {
  const root = document.documentElement;
  const look = () => root.toggleAttribute("data-window-idle", document.hidden || !document.hasFocus());
  // The blur lands before focus settles in a frame of this page; ask once it has.
  const later = () => window.setTimeout(look, 0);
  window.addEventListener("focus", look);
  window.addEventListener("blur", later);
  document.addEventListener("visibilitychange", look);
  look();
}

/** A window a tab moved into: its tabs and panes are its own, for as long as it is open. */
export const isDetachedWindow = (): boolean => !!window.tomrade?.window?.detached;

/**
 * Whether app-wide prompts — Settings a surface asked for, a clicked notification, an
 * update — land in this window. One window leads, the one the shell brings forward; when
 * it closes the shell hands the role on. A window a tab moved into starts without it.
 */
export const isLeadWindow = (): boolean => lead;

export function useLeadWindow(): boolean {
  return useSyncExternalStore((listener) => {
    leadListeners.add(listener);
    return () => leadListeners.delete(listener);
  }, isLeadWindow);
}
