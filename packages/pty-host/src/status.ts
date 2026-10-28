import type { TerminalStatus } from "@tomradex/contracts";
import { titleStatus } from "./agents.js";
import { detect } from "./detection.js";
import type { Pane } from "./pane.js";
import { manifestOf } from "./screens.js";

export { manifestOf } from "./screens.js";

/*
 * Each pane's agent read off its screen, as herdr reads it on macOS: with
 * herdr's manifest for that agent, at most every `readMs` while someone follows
 * the pane's status (else when the pane is asked about), and not at all while
 * the screen and title stay as they were. A reading is display only: it says
 * how the agent looks, never that it is safe to type into the pane (herdr
 * reads a prompt it does not know as idle).
 */

export interface ReadTiming {
  /** A pane's screen is read at most this often. */
  readMs: number;
  /** Working that turns to an idle the screen does not show outright is held this long first: a spinner between frames is not a stop (herdr's pending idle). */
  idleHoldMs: number;
}

export const READ_TIMING: ReadTiming = { readMs: 250, idleHoldMs: 300 };

interface Reading {
  agent: string | null;
  status: TerminalStatus;
  /** What was last told, as `agent:status`. */
  told: string;
  /** The pane's revision and its detection input when last read. */
  revision: number;
  seen: string | null;
  at: number;
  timer: NodeJS.Timeout | null;
  /** The next read is to happen even on an unchanged screen: an idle on hold is checked again. */
  force: boolean;
  /** Since when working has read as an idle the screen does not show. */
  idleSince: number | null;
}

export class AgentScreens {
  private readonly readings = new Map<string, Reading>();
  private readonly timing: ReadTiming;

  constructor(
    private readonly opts: {
      /** A pane's agent or its status changed. */
      told(pane: Pane, agent: string | null, status: TerminalStatus): void;
      log?: (line: string) => void;
      timing?: Partial<ReadTiming>;
    }
  ) {
    this.timing = { ...READ_TIMING, ...opts.timing };
  }

  /** How the pane's agent reads now: its screen read again first if it changed. */
  status(pane: Pane, agent: string | null): TerminalStatus {
    const reading = this.reading(pane, agent);
    this.read(pane, reading);
    return reading.status;
  }

  /** The pane drew, retitled or found another agent: read it again, at most every `readMs`. */
  changed(pane: Pane, agent: string | null): void {
    const reading = this.readings.get(pane.id);
    // Nothing to read: no agent, as before.
    if (!agent && (!reading || !reading.agent)) return;
    this.schedule(pane, this.reading(pane, agent), 0);
  }

  forget(paneId: string): void {
    const reading = this.readings.get(paneId);
    if (reading?.timer) clearTimeout(reading.timer);
    this.readings.delete(paneId);
  }

  dispose(): void {
    for (const id of [...this.readings.keys()]) this.forget(id);
  }

  /** A pane's reading, started afresh when another agent runs there. */
  private reading(pane: Pane, agent: string | null): Reading {
    let reading = this.readings.get(pane.id);
    if (reading && reading.agent !== agent) {
      if (reading.agent) pane.forgetProgress();
      Object.assign(reading, { agent, seen: null, idleSince: null, force: true });
    }
    if (!reading) {
      reading = { agent, status: "unknown", told: ":unknown", revision: -1, seen: null, at: 0, timer: null, force: true, idleSince: null };
      this.readings.set(pane.id, reading);
    }
    return reading;
  }

  private schedule(pane: Pane, reading: Reading, after: number): void {
    if (reading.timer) return;
    const wait = Math.max(after, reading.at + this.timing.readMs - Date.now(), 0);
    reading.timer = setTimeout(() => {
      reading.timer = null;
      if (this.readings.get(pane.id) === reading && !pane.exited) this.read(pane, reading);
    }, wait);
    reading.timer.unref?.();
  }

  private read(pane: Pane, reading: Reading): void {
    if (!reading.force && reading.revision === pane.revision) return;
    const forced = reading.force;
    reading.force = false;
    reading.revision = pane.revision;
    reading.at = Date.now();
    const manifest = reading.agent ? manifestOf(reading.agent, this.opts.log) : null;
    // An agent herdr has no manifest for goes by its title alone.
    if (!manifest) return this.tell(pane, reading, titleStatus(reading.agent, pane.title));
    const input = pane.detectionInput();
    const seen = `${input.oscTitle}\u0000${input.oscProgress}\u0000${input.screen}`;
    if (seen === reading.seen && !forced) return;
    reading.seen = seen;
    const detection = detect(manifest, input);
    // A screen that says nothing of the state (a transcript viewer): it stays what it was.
    if (detection.skip) return;
    if (reading.status === "working" && detection.state === "idle" && !detection.visibleIdle) {
      reading.idleSince ??= reading.at;
      const held = reading.idleSince + this.timing.idleHoldMs - reading.at;
      if (held > 0) {
        reading.force = true;
        return this.schedule(pane, reading, held);
      }
    }
    reading.idleSince = null;
    this.tell(pane, reading, detection.state);
  }

  private tell(pane: Pane, reading: Reading, status: TerminalStatus): void {
    reading.status = status;
    const told = `${reading.agent ?? ""}:${status}`;
    if (told === reading.told) return;
    reading.told = told;
    this.opts.told(pane, reading.agent, status);
  }
}
