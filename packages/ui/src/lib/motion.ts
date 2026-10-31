import { flushSync } from "react-dom";

/**
 * Short interface motion plays unless the person asked the system for less of it, turned on performance mode, or
 * Chromium composites without the GPU and would draw every frame on the CPU. The last two are words on <html>.
 */
export function motionAllowed(): boolean {
  const root = document.documentElement;
  if (root.hasAttribute("data-performance") || root.hasAttribute("data-software-compositing")) return false;
  return typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A change that swaps whole panels, run as a view transition: the browser snapshots the window before and after and
 * moves between the two on the GPU, so the board is not laid out again on every frame. The change lands a frame
 * later, once the first snapshot is taken. Without motion it simply happens.
 */
export function swapPanels(change: () => void): void {
  if (!motionAllowed() || typeof document.startViewTransition !== "function") return change();
  // The panels carry their transition names only while one runs (motion.css), so nothing else stacks differently.
  const root = document.documentElement;
  swapping += 1;
  root.classList.add("panel-swap");
  const swap = document.startViewTransition(() => flushSync(change));
  void swap.finished.finally(() => { swapping -= 1; if (swapping === 0) root.classList.remove("panel-swap"); });
}
let swapping = 0;
