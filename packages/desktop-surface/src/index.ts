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

export interface DesktopSurfaceSpec {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
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
}
