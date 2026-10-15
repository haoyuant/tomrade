import type {} from "cordis";

/** A sound this machine offers: one of the system's own, named the way the system names it. */
export interface AlertSound {
  /** `system:<name>`; a file the person chose is passed as its absolute path instead. */
  id: string;
  title: string;
}

export interface AlertNotice {
  title: string;
  body?: string;
}

/** Implemented by the native shell; a feature decides when to alert, the host how. */
export interface AlertHost {
  /** The system sounds on this machine, the one the system itself uses for alerts first. */
  sounds(): AlertSound[];
  /** Plays a system sound or an audio file once; volume runs 0–1. Resolves when it has started. */
  play(sound: string, opts?: { volume?: number }): Promise<void>;
  /** A system notification; clicking it brings the app forward. Silent: a sound is the caller's to choose. */
  notify(notice: AlertNotice): void;
}

/** Audio a person may pick for an alert, by extension. */
export const AUDIO_EXTENSIONS = ["aiff", "aif", "caf", "m4a", "mp3", "oga", "ogg", "wav", "flac"];

declare module "cordis" {
  interface Context {
    alerts: AlertHost;
  }
}
