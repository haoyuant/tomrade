import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Project } from "@tomradex/domain";
import type { IconId } from "~/components/icons";
import type { Locale, MessageKey } from "./i18n";

/**
 * "What Tomrade can do": one card per short clip of the launch videos, each
 * with a "Try it" that lands where that use begins.
 */
export type CapabilityId = "idea" | "terminal" | "sessions" | "groom" | "im";

/** What "Try it" does. The IM one opens Settings anywhere; the rest happen inside a project. */
export type TryAction =
  | { kind: "fill"; prompt: MessageKey }
  | { kind: "startPalette" }
  | { kind: "agentConnection" }
  | { kind: "imSettings" };

export interface Capability {
  id: CapabilityId;
  icon: IconId;
  title: MessageKey;
  line: MessageKey;
  action: TryAction;
  /** A bundled loop, `public/capabilities/<id>-<lang>.webm`; the still alone until the clip is made. */
  video: boolean;
}

export const CAPABILITIES: readonly Capability[] = [
  { id: "idea", icon: "i-merge", title: "capabilities.ideaTitle", line: "capabilities.ideaLine", action: { kind: "fill", prompt: "agentPanel.starterIdeaPrompt" }, video: false },
  { id: "terminal", icon: "i-terminal", title: "capabilities.terminalTitle", line: "capabilities.terminalLine", action: { kind: "agentConnection" }, video: false },
  { id: "sessions", icon: "i-cards", title: "capabilities.sessionsTitle", line: "capabilities.sessionsLine", action: { kind: "startPalette" }, video: false },
  { id: "groom", icon: "i-undo", title: "capabilities.groomTitle", line: "capabilities.groomLine", action: { kind: "fill", prompt: "agentPanel.starterGroomPrompt" }, video: false },
  { id: "im", icon: "i-send", title: "capabilities.imTitle", line: "capabilities.imLine", action: { kind: "imSettings" }, video: false }
];

export const isCapabilityId = (id: string): id is CapabilityId => CAPABILITIES.some((c) => c.id === id);

/** The recordings are made in English and Chinese; every other language watches the English one. */
export function mediaOf(capability: Capability, locale: Locale, base: string): { poster: string; video: string | null } {
  const lang = locale === "zh" || locale.startsWith("zh-") ? "zh" : "en";
  const stem = `${base}capabilities/${capability.id}-${lang}`;
  return { poster: `${stem}.webp`, video: capability.video ? `${stem}.webm` : null };
}

/** Projects not put away; the home shows the cards while there are this few. */
export const HOME_CARDS_UNTIL = 3;
export const showsOnHome = (projects: readonly Project[]): boolean => projects.filter((p) => !p.archived).length <= HOME_CARDS_UNTIL;

/** The project a "Try it" from outside any project goes to: the open one, else the first in use, else the sample. */
export function projectToTry(projects: readonly Project[], current: string | null): string | null {
  const live = projects.filter((p) => !p.archived);
  if (current && live.some((p) => p.id === current)) return current;
  return (live.find((p) => !p.sample) ?? live[0])?.id ?? null;
}

/** An announcement links a card as `#capabilities/<id>`, or the whole page as `#capabilities`; the sanitizer keeps a hash link. */
export function capabilityLink(href: string): { focus: CapabilityId | null } | null {
  const m = /^#capabilities(?:\/([\w-]+))?$/.exec(href.trim());
  if (!m) return null;
  return { focus: m[1] && isCapabilityId(m[1]) ? m[1] : null };
}

/** Motion stays still for those who asked the system for less of it. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches
  );
}

// ── Opening the page, from the Help menu, the palette or an announcement ──

declare module "@tomradex/ipc" {
  interface Broadcasts {
    /** The Help menu's "What Tomrade can do", sent to the main window it brought forward. */
    "app.capabilities": () => void;
  }
}

let wanted: { focus: CapabilityId | null; at: number } | null = null;
const openListeners = new Set<() => void>();

export function openCapabilities(focus: CapabilityId | null = null): void {
  wanted = { focus, at: Date.now() };
  for (const listener of openListeners) listener();
}

/** The root's page: open while asked, on the card asked for. */
export function useCapabilitiesRequest(): { open: boolean; focus: CapabilityId | null; at: number; close: () => void } {
  const [state, setState] = useState<{ focus: CapabilityId | null; at: number } | null>(null);
  useEffect(() => {
    const take = () => setState(wanted);
    openListeners.add(take);
    if (wanted) take();
    return () => void openListeners.delete(take);
  }, []);
  const close = useCallback(() => {
    wanted = null;
    setState(null);
  }, []);
  return { open: !!state, focus: state?.focus ?? null, at: state?.at ?? 0, close };
}

// ── "Try it": the project's workspace carries it out ──

type TryHost = { projectId: string; run: (action: TryAction) => void };
const hosts: TryHost[] = [];
// Asked from outside the project: waits for its workspace to mount.
let pending: { projectId: string; action: TryAction; at: number } | null = null;

/** Mounted by a project's workspace: it carries out a "Try it", now or once it opens. */
export function useTryHost(projectId: string, run: (action: TryAction) => void): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const host: TryHost = { projectId, run: (action) => latest.current(action) };
    hosts.push(host);
    const waiting = pending;
    if (waiting?.projectId === projectId && Date.now() - waiting.at < 15_000) {
      pending = null;
      // after the first paint, so the panel and dialogs it reaches are mounted
      requestAnimationFrame(() => host.run(waiting.action));
    }
    return () => void hosts.splice(hosts.indexOf(host), 1);
  }, [projectId]);
}

/** The workspace on show, if any. */
export const tryHost = (): TryHost | undefined => hosts.at(-1);

/** For a project not open yet: the action waits until its workspace mounts. */
export function tryLater(projectId: string, action: TryAction): void {
  pending = { projectId, action, at: Date.now() };
}
