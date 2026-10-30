import type {} from "cordis";

export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceCapabilities {
  /** False on compositors such as Wayland that do not allow clients to place top-level windows. */
  programmaticPosition: boolean;
  /** Per-pixel-ish pass-through driven by renderer hit testing is supported. */
  forwardedMouseMoves: boolean;
}

/** How the app looks right now, for a surface document to match: the theme's CSS variables and the language. */
export interface SurfaceLook {
  /** The theme in use: a built-in's name or a custom theme's id. */
  theme: string;
  dark: boolean;
  /** `--name` → value, the app's theme variables as the main window computes them. */
  tokens: Record<string, string>;
  locale: string;
  /**
   * The main window asks for the system's frosted material (Glass); the shell answers whether this
   * window wears it, and a page under it leaves its own background off. Absent from an older shell.
   */
  frosted?: boolean;
  /** A custom theme made from pictures: its panes' opacity and frost; `terminalVeil` once the Terminal window has a picture of its own. */
  backdrop?: { veil: number; frost: number; terminalVeil?: number };
}

export interface DesktopSurfaceSpec {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
  /**
   * `window`: a working window — native frame, resizable, minimizable, full screen, closable, in
   * the Dock or taskbar, its last bounds restored by id. `widget` (the default): fixed and frameless.
   */
  kind?: "widget" | "window";
  /** Windows only. */
  minWidth?: number;
  minHeight?: number;
  /**
   * `window` only: its page keeps a draggable strip `env(titlebar-area-height)` tall at its top. Where a window has to be
   * born frameless to wear Glass's frost (Windows 10), only such a window wears it; the caption buttons sit over the strip.
   */
  captionStrip?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  /** Allow keyboard input; defaults to false for passive widgets. */
  focusable?: boolean;
  visibleOnAllWorkspaces?: boolean;
  /** The surface document may mark opaque pixels interactive through the generic preload bridge. */
  clickThrough?: boolean;
  /**
   * Where it first appears: on top of the app window's element marked `data-surface-anchor` with this name,
   * left edges aligned. Not on screen (another page, a collapsed sidebar), the bottom-right of the work area.
   */
  anchor?: string;
  initialState?: unknown;
  /** Messages from the isolated surface document, owned and interpreted by the feature. */
  onMessage?(message: unknown): void;
  /** Once, when the window is gone: closed by the person, by `close()`, or by the host unloading. */
  onClose?(): void;
}

export interface DesktopSurface {
  readonly id: string;
  readonly capabilities: SurfaceCapabilities;
  bounds(): SurfaceBounds;
  workArea(): SurfaceBounds;
  setPosition(x: number, y: number): void;
  setState(state: unknown): void;
  /** One message to the document, in order; sent once it has loaded. */
  post(message: unknown): void;
  /** Shown in front with focus, restored if minimized. */
  focus(): void;
  close(): void;
}

/** Implemented by the native shell; feature plugins own when their surfaces exist. */
export interface DesktopSurfaceHost {
  open(spec: DesktopSurfaceSpec): DesktopSurface;
}

declare module "cordis" {
  interface Context {
    desktopSurfaces: DesktopSurfaceHost;
  }
  interface Events {
    /** Bring the app window forward on a project's conversation, or on its ticket when there is none. */
    "desktop/open"(target: { projectId: string; threadId?: string; itemId?: string }): void;
    /** A web page in the person's browser; anything but http(s) is ignored. */
    "desktop/open-external"(url: string): void;
    /** A folder or file shown in Finder or Explorer. */
    "desktop/reveal"(target: string): void;
    /** Open a local path in its system default application. */
    "desktop/open-path"(target: string): void;
    /** The app comes in front of the one the person is in, for a window it shows at their word from outside (the `tomrade` command). */
    "desktop/activate"(): void;
    /** Whether any of the app's windows can be seen (shown, not minimized) changed; background work may slow down while none can. */
    "desktop/seen"(seen: boolean): void;
  }
}
