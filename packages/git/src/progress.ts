/** A step of a sync, in the order one takes them. */
export type SyncStep = "saving" | "reaching" | "fetching" | "merging" | "pushing";

/** What git last said of a transfer: "Receiving objects:  45% (961/2137), 5.32 MiB | 15.00 KiB/s". */
export interface SyncTransfer {
  phase: string;
  percent: number;
  done: number;
  total: number;
  /** As git wrote them; it never says how much is left to download. */
  size?: string;
  rate?: string;
}

/** Where a running sync is. */
export interface SyncProgress {
  step: SyncStep;
  /** When the sync began, and when this step did. */
  since: number;
  stepSince: number;
  transfer?: SyncTransfer;
}

export interface SyncStepRecord {
  step: SyncStep;
  ms: number;
  ok: boolean;
}

/** What the last sync did and what git said, for a person to read when it went wrong. Nothing in it is secret. */
export interface SyncTrace {
  at: number;
  steps: SyncStepRecord[];
  remote: string | null;
  branch: string | null;
  directory?: string;
  /** The proxy git went through, without a credential; null when it went direct. */
  proxy: string | null;
  /** git's last lines, progress and credentials left out. */
  output: string;
}

const TRANSFER = /([A-Z][A-Za-z ]*?):\s+(\d+)% \((\d+)\/(\d+)\)(?:,\s*([\d.]+ [KMGT]?i?B))?(?:\s*\|\s*([\d.]+ [KMGT]?i?B\/s))?/g;
const scrub = (text: string): string => text.replace(/\/\/[^@\s/]*@/g, "//");

/** The latest transfer line in a piece of git's stderr, which rewrites one line with `\r` as it goes. */
export function parseGitProgress(text: string): SyncTransfer | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(TRANSFER)) last = match;
  if (!last) return null;
  const [, phase, percent, done, total, size, rate] = last;
  return { phase: phase!.trim(), percent: Number(percent), done: Number(done), total: Number(total), ...(size ? { size } : {}), ...(rate ? { rate } : {}) };
}

/** The proxy Tomrade put in git's environment — the system's, or the person's own — without a credential. */
export function proxyInUse(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy;
  return url ? scrub(url) : null;
}

const PACE_MS = 300;
const KEEP_CHARS = 8000;
const OUTPUT_LINES = 12;

/**
 * One sync as it goes: its steps and their times, what git reports of a
 * transfer, and the tail of what it said. A new step is told at once; a
 * transfer's updates at most every PACE_MS, so a fast one cannot flood the window.
 */
export class SyncRecorder {
  private readonly since = Date.now();
  private readonly steps: SyncStepRecord[] = [];
  private current: { step: SyncStep; since: number; ok: boolean } | null = null;
  private transfer: SyncTransfer | undefined;
  private said = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private told = 0;
  private where: { remote: string | null; branch: string | null; directory?: string } = { remote: null, branch: null };

  constructor(private readonly tell: (progress: SyncProgress | null) => void = () => {}) {}

  /** Where the sync goes, once it is known: a save comes first, before the remote is asked for. */
  locate(where: { remote: string | null; branch: string | null; directory?: string }): void {
    this.where = { remote: where.remote && scrub(where.remote), branch: where.branch, ...(where.directory ? { directory: where.directory } : {}) };
  }

  step(step: SyncStep): void {
    this.close();
    this.current = { step, since: Date.now(), ok: true };
    this.transfer = undefined;
    this.emit();
  }

  /** The current step went wrong; it stays in the trace as failed. */
  fail(): void {
    if (this.current) this.current.ok = false;
  }

  /** Hand to a git command as its `onStderr`. */
  readonly stderr = (text: string): void => {
    this.said = (this.said + text).slice(-KEEP_CHARS);
    const transfer = parseGitProgress(text);
    if (!transfer) return;
    this.transfer = transfer;
    const wait = this.told + PACE_MS - Date.now();
    if (wait <= 0) this.emit();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit();
      }, wait);
      this.timer.unref?.();
    }
  };

  progress(): SyncProgress | null {
    return this.current ? { step: this.current.step, since: this.since, stepSince: this.current.since, ...(this.transfer ? { transfer: this.transfer } : {}) } : null;
  }

  /** Whether the sync got as far as a remote; one that only saved here leaves nothing worth reading. */
  get located(): boolean {
    return this.where.remote !== null;
  }

  /** End the sync: a window that heard of it hears it is over, and the trace is what stays. */
  finish(): SyncTrace {
    this.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.told) this.tell(null);
    const lines = scrub(this.said).split(/[\r\n]+/).map((line) => line.trimEnd()).filter((line) => line.trim() && !parseGitProgress(line));
    return { at: Date.now(), steps: [...this.steps], ...this.where, proxy: proxyInUse(), output: lines.slice(-OUTPUT_LINES).join("\n") };
  }

  private close(): void {
    if (this.current) this.steps.push({ step: this.current.step, ms: Date.now() - this.current.since, ok: this.current.ok });
    this.current = null;
  }

  private emit(): void {
    this.told = Date.now();
    this.tell(this.progress());
  }
}
