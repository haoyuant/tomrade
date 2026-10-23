import { useEffect, type ReactNode } from "react";
import { invoke } from "~/lib/api";
import { logQuietly } from "~/lib/api";

/**
 * What the person is using, for the anonymous usage statistics. A surface is
 * timed only while the window has focus and the person last touched it; the
 * main process owns the clock, this only says which region that was.
 */

const ATTRIBUTE = "data-analytics-surface";
let reported: string | null = null;
let installed = false;

/** The most recently touched surface, reported only when it changes. */
export function reportSurface(feature: string | null): void {
  if (feature === reported) return;
  reported = feature;
  void Promise.resolve(invoke("analytics.surface", feature)).catch(logQuietly("analytics"));
}

/** A counted action (or one the registry keeps for adoption only). */
export function reportAction(feature: string, action: string, dim?: string): void {
  void Promise.resolve(invoke("analytics.activate", feature, action, dim ?? null)).catch(logQuietly("analytics"));
}

/** Once: any interaction anywhere belongs to the nearest surface around it. */
function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const touched = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const surface = target.closest(`[${ATTRIBUTE}]`)?.getAttribute(ATTRIBUTE);
    if (surface) reportSurface(surface);
  };
  document.addEventListener("pointerdown", touched, true);
  document.addEventListener("keydown", touched, true);
  document.addEventListener("wheel", touched, { capture: true, passive: true });
}

export interface SurfaceProps {
  /** A registry id: `backlog.board`, `files.browse`, `agent.chat`… */
  feature: string;
  /**
   * Report on mount, for a screen that replaces the last one. A region that
   * stays on screen beside others (the assistant panel) reports on interaction
   * only, or it would take the time of whatever is being read.
   */
  onMount?: boolean;
  children: ReactNode;
}

/**
 * Marks a region as a feature's surface. `display: contents` keeps the DOM
 * exactly as it was: this adds a boundary for hit testing, not a box.
 */
export function Surface({ feature, onMount = true, children }: SurfaceProps) {
  useEffect(() => {
    install();
    if (onMount) reportSurface(feature);
    return () => {
      if (reported === feature) reportSurface(null);
    };
  }, [feature, onMount]);
  return (
    <div {...{ [ATTRIBUTE]: feature }} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
