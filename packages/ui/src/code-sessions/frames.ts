/**
 * Jobs run together in the next animation frame, each once however often it was asked for meanwhile: a window
 * dragged wider tells every cell's observer many times a frame, and each fit reads the layout.
 */
export function frameBatch(schedule: (run: () => void) => unknown = (run) => requestAnimationFrame(run)) {
  const jobs = new Set<() => void>();
  let queued = false;
  return {
    soon(job: () => void): void {
      jobs.add(job);
      if (queued) return;
      queued = true;
      schedule(() => {
        queued = false;
        const due = [...jobs];
        jobs.clear();
        for (const run of due) run();
      });
    },
    cancel(job: () => void): void {
      jobs.delete(job);
    }
  };
}
