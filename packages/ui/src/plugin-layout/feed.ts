import type { LayoutState, LayoutStateKey } from "@tomradex/plugin-sdk";
import { changedKeys } from "./protocol";

export type FeedListener = (state: LayoutState, changed: ReadonlySet<LayoutStateKey>) => void;
export type Schedule = (flush: () => void) => () => void;

const nextFrame: Schedule = (flush) => {
  const id = requestAnimationFrame(flush);
  return () => cancelAnimationFrame(id);
};

/**
 * The window's side of a layout's state: every render that touches the view
 * sets the next state, and listeners hear one coalesced change per frame with
 * the keys that differ from what they last saw. Both ways of mounting a layout
 * sit on this — native listeners are the plugin's own, a sandbox's is the
 * message that crosses to its frame.
 */
export class LayoutFeed {
  private current: LayoutState;
  /** What listeners were last told. */
  private told: LayoutState;
  private pending = new Set<LayoutStateKey>();
  private cancel: (() => void) | null = null;
  private listeners = new Set<FeedListener>();

  constructor(initial: LayoutState, private readonly schedule: Schedule = nextFrame) {
    this.current = initial;
    this.told = initial;
  }

  get state(): LayoutState {
    return this.current;
  }

  set(next: LayoutState): void {
    for (const key of changedKeys(this.current, next)) this.pending.add(key);
    this.current = next;
    if (this.pending.size && !this.cancel) this.cancel = this.schedule(() => this.flush());
  }

  listen(listener: FeedListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Tells listeners now; a key set and set back between frames is not reported. */
  flush(): void {
    this.cancel?.();
    this.cancel = null;
    const changed = new Set([...this.pending].filter((key) => this.told[key] !== this.current[key]));
    this.pending.clear();
    this.told = this.current;
    if (!changed.size) return;
    for (const listener of this.listeners) listener(this.current, changed);
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = null;
    this.listeners.clear();
  }
}
