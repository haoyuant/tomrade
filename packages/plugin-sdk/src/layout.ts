import type { FieldDef, Item, Patch, ViewQuery } from "@tomradex/domain";
import type { Disposer, Localized } from "./contract.js";

/**
 * SDK 0.2.31. A backlog layout: a page of the plugin's own beside Board, Table
 * and Graph. The plugin ships one ES module whose default export is a
 * `LayoutModule`; Tomrade mounts it into the backlog region and hands it the
 * view's state. The same module runs sandboxed (an isolated frame, the default)
 * or native (inside Tomrade's window, which takes `permissions.renderer`).
 */
export interface LayoutSpec {
  /** Carries the plugin's namespace; the view stores it as `plugin:<id>`. */
  id: string;
  title: Localized;
  /** Icon id from the renderer's sprite; unknown names fall back. */
  icon?: string;
  /** The module inside the plugin's package, relative to its root. */
  module: string;
  /** `sandbox` (default): an isolated frame. `native`: Tomrade's own window — needs `permissions.renderer`. */
  render?: "sandbox" | "native";
}

/** How the app looks right now: the theme's variables and the language, so a layout can match. */
export interface LayoutLook {
  theme: string;
  dark: boolean;
  /** `--name` → value, the theme's CSS variables as the main window computes them. */
  tokens: Record<string, string>;
  locale: string;
}

export interface LayoutState {
  projectId: string;
  /** The view's tickets after its filter, search and sort, in that order. An unchanged ticket keeps its object between changes, so `===` tells what moved. */
  items: Item[];
  /** Every field the project has, built-ins first, in rank order. */
  fields: FieldDef[];
  query: ViewQuery;
  /** The ticket open in the detail pane. */
  selectedId: string | null;
  look: LayoutLook;
}

export type LayoutStateKey = keyof LayoutState;

export interface LayoutApi {
  /** The state as of now; a new object whenever something changed. */
  readonly state: LayoutState;
  /** Hears every change, coalesced per frame; `changed` names the keys that differ from the last call. */
  onChange(listener: (state: LayoutState, changed: ReadonlySet<LayoutStateKey>) => void): Disposer;
  /** Opens a ticket in the detail pane, or closes it with null. */
  select(id: string | null): Promise<void>;
  /** Patches a ticket as the person: the write is theirs, undoable, and refused where any write would be. */
  update(id: string, patch: Patch): Promise<void>;
}

export interface LayoutHandle {
  /** The region is going away: take listeners and timers with it. */
  unmount(): void;
}

/** The default export of a layout's module. */
export interface LayoutModule {
  mount(root: HTMLElement, api: LayoutApi): LayoutHandle | Promise<LayoutHandle>;
}
