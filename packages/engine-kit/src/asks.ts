import type { TurnIO } from "@tomradex/agent";

/** What `OpenAsks.ask` returns when a mode picked while the question waited allows the call. */
export const MODE_ALLOWS = Symbol("mode allows");

/**
 * The permission questions an engine has put to the person, so a mode picked
 * while they wait settles each one that mode would not have asked.
 */
export class OpenAsks {
  private open = new Map<AbortController, () => boolean>();

  /** The person's answer, MODE_ALLOWS once `allows()` turns true while it waits, or null when cancelled. */
  async ask(io: TurnIO, text: string, options: string[], allows: () => boolean, signal?: AbortSignal): Promise<string | typeof MODE_ALLOWS | null> {
    const settle = new AbortController();
    this.open.set(settle, allows);
    try {
      const answer = (await io.requestPermission?.(text, options, signal ? AbortSignal.any([signal, settle.signal]) : settle.signal)) ?? null;
      if (!settle.signal.aborted || signal?.aborted || io.signal.aborted) return answer;
      io.emit({ type: "note", text: "Allowed without asking: the permission mode picked meanwhile allows it" });
      return MODE_ALLOWS;
    } finally {
      this.open.delete(settle);
    }
  }

  /** After a mode change: settle every waiting question the mode now allows. */
  settle(): void {
    for (const [settle, allows] of this.open) if (allows()) settle.abort();
  }
}
