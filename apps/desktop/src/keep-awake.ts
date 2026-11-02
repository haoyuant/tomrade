import { powerSaveBlocker } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/night-shift";

export interface Blocker {
  start(): number;
  stop(id: number): void;
}

/** Holds the blocker exactly while `wanted` says so; call it whenever that may have changed. */
export function holdAwake(wanted: () => boolean, blocker: Blocker): { sync(): void; release(): void } {
  let held: number | null = null;
  const release = () => {
    if (held !== null) blocker.stop(held);
    held = null;
  };
  return {
    sync() {
      if (!wanted()) release();
      else held ??= blocker.start();
    },
    release
  };
}

/** The computer does not sleep through a night shift. The screen may: `prevent-app-suspension` asks only that the system stays up. */
export function keepAwake(root: Context): void {
  root.inject(["nightShift"], (ctx) => {
    const hold = holdAwake(() => ctx.nightShift.wantsAwake(), { start: () => powerSaveBlocker.start("prevent-app-suspension"), stop: (id) => powerSaveBlocker.stop(id) });
    hold.sync();
    ctx.on("nightShift/changed", hold.sync);
    ctx.effect(() => hold.release, "keep awake");
  });
}
