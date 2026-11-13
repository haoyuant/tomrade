import { useLayoutEffect } from "react";

/** The pass before the first frame of a film that has nothing to measure. */
export function Ready({ onDone }: { onDone: (ready: true) => void }) {
  useLayoutEffect(() => onDone(true), [onDone]);
  return null;
}
