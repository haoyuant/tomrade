import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import { errorMessage } from "@tomradex/contracts";

/*
 * Recordings of what the Terminal window's cells showed: the frames a pane's
 * stream painted, as they came, one file per stretch a cell was attached
 * ("segment"). An ended session or a closed terminal reads its stretch back by
 * the time it ran. Everything here stays in the machine's own data folder.
 *
 * A segment file is one JSON line (`SegmentHeader`), then records back to
 * back: a 13-byte head — t:u32 (ms since the segment began) w:u16 h:u16
 * flags:u8 len:u32, big-endian — and the frame's bytes. The first record
 * paints the whole screen: the attach's full frame, or a snapshot the window
 * took, so a replay can start at any segment.
 */

export const RecordingSettings = z.object({
  enabled: z.boolean().default(true).meta({ title: "Record terminal output" }).describe("Keep what the Terminal window's panes show, so an ended session or a closed terminal can be played back as raw output. Only while a pane is shown in the window; the recordings never leave this computer."),
  maxTotalMB: z.number().int().min(64).max(65536).default(1024).meta({ title: "Keep at most (MB)", advanced: true }).describe("The oldest recordings go once they take more than this together."),
  keepDays: z.number().int().min(1).max(3650).default(14).meta({ title: "Keep for (days)", advanced: true }).describe("A recording older than this goes.")
});
export type RecordingSettings = z.infer<typeof RecordingSettings>;

export const RECORDING_SECTION: SettingsSection<RecordingSettings> = {
  id: "terminalRecording",
  title: "Terminal recording",
  description: "The Terminal window records what each pane shows while a cell shows it, so an ended session or a closed terminal can be played back as raw output. The recordings stay in this computer's data folder and are never synced.",
  schema: RecordingSettings,
  defaults: RecordingSettings.parse({}),
  scope: "machine",
  order: 31,
  words: {
    zh: {
      title: "终端录制",
      description: "终端窗口在格子显示某个窗格期间录下它的画面，结束的会话和关掉的终端可以用「原始输出」回放。录制只在终端窗口显示这个窗格时进行，保存在本机数据目录，不同步到远端。",
      fields: {
        enabled: { title: "录制终端输出", description: "录下终端窗口里窗格的画面，供结束后回放。只在终端窗口显示这个窗格时录制；录制不离开这台电脑。" },
        maxTotalMB: { title: "最多保留（MB）", description: "所有录制加起来超过这个大小时，从最旧的开始删除。" },
        keepDays: { title: "保留天数", description: "超过这个天数的录制会被删除。" }
      }
    }
  }
};

/** The first record of a segment paints the whole screen. */
export const FLAG_FULL = 1;
/** A screen the window serialized, rather than a frame the pane painted: a replay resets before it. */
export const FLAG_KEYFRAME = 2;
/** Frames before this one were dropped (the disk could not keep up). */
export const FLAG_GAP = 4;

export const RECORD_HEAD = 13;
/** A segment past this asks the window for a snapshot to begin the next one with, so a replay never reads more than about this much before its start. */
export const SEGMENT_MAX = 16 * 1024 * 1024;
/** Frames held while a snapshot is awaited: past this much, or this long, they go into the open segment and no new one begins. */
export const HOLD_MAX = 4 * 1024 * 1024;
export const HOLD_MS = 1_000;
/** Bytes a segment's stream may hold unwritten before frames are dropped rather than queued: the disk is not keeping up. */
export const WRITE_BUFFER_MAX = 8 * 1024 * 1024;
/** The most a replay sends the window at once. */
export const REPLAY_MAX = 32 * 1024 * 1024;

export interface SegmentHeader {
  v: 1;
  pane: string;
  startedAt: number;
  cols: number;
  rows: number;
}

/** One frame as a recording takes it: the batch the window was sent, with the sequence the window will name it by. */
export interface RecordedFrame {
  seq: number;
  width: number;
  height: number;
  full: boolean;
  bytes: Uint8Array;
}

/** One record read back, its time absolute. */
export interface ReplayRecord {
  t: number;
  w: number;
  h: number;
  full: boolean;
  key: boolean;
  bytes: Uint8Array;
}

export interface Slice {
  /** In order; those before `at` bring the screen to the slice's start and are not shown. */
  records: ReplayRecord[];
  at: number;
  /** The slice's own start did not fit under REPLAY_MAX: it begins later than the session did. */
  cut: boolean;
  /** The first record paints the whole screen; otherwise the picture fills in as it plays. */
  clean: boolean;
}

interface Segment {
  dir: string;
  file: string;
  start: number;
  /** Null while open, or when the file was never closed (then its last change says). */
  end: number | null;
  size: number;
  open: boolean;
  /** Its last write and its naming for its end, under way. */
  settling?: Promise<void>;
}

export const paneDir = (pane: string): string => pane.replace(/[^A-Za-z0-9_.-]/g, "_") || "pane";

const SEGMENT_NAME = /^(\d+)(?:-(\d+))?\.rec$/;

const head = (t: number, w: number, h: number, flags: number, len: number): Buffer => {
  const b = Buffer.alloc(RECORD_HEAD);
  b.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(t))), 0);
  b.writeUInt16BE(Math.max(0, Math.min(0xffff, w)), 4);
  b.writeUInt16BE(Math.max(0, Math.min(0xffff, h)), 6);
  b.writeUInt8(flags & 0xff, 8);
  b.writeUInt32BE(len, 9);
  return b;
};

/** The records of a segment file, as far as it can be read: a cut-off tail (the app died writing) ends the list. */
export function parseSegment(data: Buffer): { header: SegmentHeader | null; records: { t: number; w: number; h: number; flags: number; bytes: Uint8Array }[] } {
  const nl = data.indexOf(0x0a);
  if (nl < 0) return { header: null, records: [] };
  let header: SegmentHeader | null = null;
  try {
    const parsed = JSON.parse(data.subarray(0, nl).toString("utf8")) as SegmentHeader;
    if (parsed && parsed.v === 1 && typeof parsed.startedAt === "number") header = parsed;
  } catch {
    return { header: null, records: [] };
  }
  const records: { t: number; w: number; h: number; flags: number; bytes: Uint8Array }[] = [];
  let at = nl + 1;
  while (at + RECORD_HEAD <= data.length) {
    const len = data.readUInt32BE(at + 9);
    if (at + RECORD_HEAD + len > data.length) break;
    records.push({ t: data.readUInt32BE(at), w: data.readUInt16BE(at + 4), h: data.readUInt16BE(at + 6), flags: data.readUInt8(at + 8), bytes: new Uint8Array(data.subarray(at + RECORD_HEAD, at + RECORD_HEAD + len)) });
    at += RECORD_HEAD + len;
  }
  return { header, records };
}

/**
 * What of these records a replay gets: from the last whole-screen paint before `from` (the catch-up, not shown) to
 * the last record at `to`, under `cap` bytes. Over the cap, the start goes: to the first whole-screen paint that fits,
 * else to whatever fits, which a replay then fills in as it plays.
 */
export function sliceOf(records: ReplayRecord[], from: number, to: number, cap = REPLAY_MAX): Slice {
  const kept = records.filter((r) => r.t <= to);
  let first = 0;
  for (let i = 0; i < kept.length && kept[i]!.t < from; i++) if (kept[i]!.full) first = i;
  let list = kept.slice(first);
  let at = list.findIndex((r) => r.t >= from);
  if (at < 0) at = list.length;
  // Beginning on a whole-screen paint (a stretch begun as the session did), nothing before it is needed.
  if (at < list.length && list[at]!.full) {
    list = list.slice(at);
    at = 0;
  }
  let total = list.reduce((n, r) => n + r.bytes.length, 0);
  let cut = false;
  let clean = list.length > 0 && list[0]!.full;
  if (total > cap) {
    // From the end, how far back fits; the nearest whole-screen paint inside that keeps the picture right.
    let k = list.length;
    let sum = 0;
    while (k > 0 && sum + list[k - 1]!.bytes.length <= cap) sum += list[--k]!.bytes.length;
    let start = k;
    for (let i = k; i < list.length; i++) {
      if (list[i]!.full) {
        start = i;
        break;
      }
    }
    clean = list[start]?.full ?? false;
    cut = start > at;
    at = Math.max(0, at - start);
    list = list.slice(start);
    total = list.reduce((n, r) => n + r.bytes.length, 0);
  }
  return { records: list, at, cut, clean };
}

/** One attached cell's recording: its open segment, and the frames held while the window takes a snapshot. */
export class Recording {
  private segment: { stream: fs.WriteStream; seg: Segment; failed: boolean; gap: boolean } | null = null;
  private held: (RecordedFrame & { at: number })[] | null = null;
  private heldBytes = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private token = 0;
  private rotating = false;
  private ended = false;

  constructor(
    private readonly recorder: Recorder,
    readonly pane: string,
    private readonly hooks: { needKeyframe(): void; warn(reason: string): void }
  ) {}

  get closed(): boolean {
    return this.ended;
  }

  /** How much the open segment holds. */
  get bytes(): number {
    return this.segment?.seg.size ?? 0;
  }

  write(frame: RecordedFrame): void {
    if (this.ended || !frame.bytes.length) return;
    if (this.held) {
      this.held.push({ ...frame, at: this.recorder.now() });
      this.heldBytes += frame.bytes.length;
      if (this.heldBytes > HOLD_MAX) this.release();
      return;
    }
    this.put(frame, frame.full ? FLAG_FULL : 0);
    if (this.segment && this.segment.seg.size >= SEGMENT_MAX && !this.rotating) {
      this.rotating = true;
      // Outside the frame's own flush: the hook asks the window, which flushes what waits first.
      queueMicrotask(() => !this.ended && this.hooks.needKeyframe());
    }
  }

  /** Frames wait in memory for the snapshot of `keyframe`; the token tells a late answer from the one awaited. */
  hold(): number {
    if (this.held) return this.token;
    this.held = [];
    this.heldBytes = 0;
    this.holdTimer = setTimeout(() => this.release(), HOLD_MS);
    this.holdTimer.unref?.();
    return ++this.token;
  }

  /**
   * The window's screen as of frame `seq`: the frames held up to it close the open segment, and a new one begins with
   * the snapshot, the rest after it. An answer to an older ask, or one nothing waits for, changes nothing.
   */
  keyframe(token: number, seq: number, width: number, height: number, bytes: Uint8Array): void {
    if (this.ended || token !== this.token || !this.held || !bytes.length) return;
    const held = this.held;
    this.endHold();
    for (const f of held) if (f.seq <= seq) this.put(f, f.full ? FLAG_FULL : 0, f.at);
    this.closeSegment();
    this.put({ width, height, bytes }, FLAG_FULL | FLAG_KEYFRAME);
    for (const f of held) if (f.seq > seq) this.put(f, f.full ? FLAG_FULL : 0, f.at);
  }

  /** No snapshot came: what was held goes into the open segment, in order. */
  private release(): void {
    if (!this.held) return;
    const held = this.held;
    this.endHold();
    for (const f of held) this.put(f, f.full ? FLAG_FULL : 0, f.at);
  }

  private endHold(): void {
    this.held = null;
    this.heldBytes = 0;
    this.rotating = false;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** A record, timed as the frame came (`at`), into the open segment, or a new one begun at that time. */
  private put(frame: { width: number; height: number; bytes: Uint8Array }, flags: number, at = this.recorder.now()): void {
    const now = at;
    if (!this.segment) this.openSegment(now, frame.width, frame.height);
    const s = this.segment;
    if (!s || s.failed) return;
    // Queued past what the disk takes: this frame is dropped, and the next one says so.
    if (s.stream.writableLength > WRITE_BUFFER_MAX) {
      s.gap = true;
      return;
    }
    const withGap = s.gap ? flags | FLAG_GAP : flags;
    s.gap = false;
    s.stream.write(head(now - s.seg.start, frame.width, frame.height, withGap, frame.bytes.length));
    s.stream.write(frame.bytes);
    s.seg.size += RECORD_HEAD + frame.bytes.length;
  }

  private openSegment(start: number, cols: number, rows: number): void {
    const seg = this.recorder.beginSegment(this.pane, start);
    if (!seg) return;
    let stream: fs.WriteStream;
    try {
      fs.mkdirSync(path.dirname(seg.file), { recursive: true });
      stream = fs.createWriteStream(seg.file, { flags: "a" });
    } catch (error) {
      this.recorder.forgetSegment(seg);
      this.fail(errorMessage(error));
      return;
    }
    const entry = { stream, seg, failed: false, gap: false };
    this.segment = entry;
    stream.on("error", (error) => {
      if (this.segment === entry) this.fail(errorMessage(error));
      entry.failed = true;
    });
    const header: SegmentHeader = { v: 1, pane: this.pane, startedAt: start, cols, rows };
    const line = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
    stream.write(line);
    seg.size += line.length;
  }

  private closeSegment(): void {
    const s = this.segment;
    if (!s) return;
    this.segment = null;
    const end = this.recorder.now();
    // Named for its end once its last write is on disk (Windows will not rename a file still open).
    s.seg.settling = new Promise<void>((resolve) => s.stream.end(() => resolve())).then(() => this.recorder.endSegment(s.seg, end));
  }

  /** The recording fails as a whole: said once, and the cell's frames go on to the window as before. */
  private fail(reason: string): void {
    if (this.ended) return;
    const s = this.segment;
    this.segment = null;
    if (s) {
      s.failed = true;
      s.stream.destroy();
      void this.recorder.endSegment(s.seg, this.recorder.now());
    }
    this.ended = true;
    this.endHold();
    this.hooks.warn(reason);
  }

  close(): void {
    if (this.ended) return;
    this.release();
    this.closeSegment();
    this.ended = true;
    this.recorder.closed(this);
  }
}

export interface RecorderOptions {
  /** Where the recordings go; none means nothing is recorded. */
  dir: string | null;
  settings: () => RecordingSettings;
  warn: (message: string) => void;
  now?: () => number;
}

/**
 * The recordings on this machine: one folder per pane, the segments in it named by when they began and ended. The
 * index is read from the folder once, then kept as segments open, close and go; nothing here runs on a timer. The
 * oldest go when the total passes the setting's cap, and any older than the setting's days, whenever a segment
 * closes.
 */
export class Recorder {
  private index: Map<string, Segment[]> | null = null;
  private readonly live = new Set<Recording>();
  private cleaning: Promise<void> | null = null;
  private cleanAgain = false;
  readonly now: () => number;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
  }

  get dir(): string | null {
    return this.options.dir;
  }

  enabled(): boolean {
    return !!this.options.dir && this.options.settings().enabled;
  }

  /** A recording of a pane's stream, or null when recording is off. */
  open(pane: string, hooks: { needKeyframe(): void; warn(reason: string): void }): Recording | null {
    if (!this.enabled()) return null;
    const recording = new Recording(this, pane, hooks);
    this.live.add(recording);
    // The first recording of the run tidies what earlier runs left; nothing waits on it.
    if (this.live.size === 1 && !this.cleaning) void this.cleanup();
    return recording;
  }

  /** Every recording closed: the window went, or recording was turned off. */
  closeAll(): void {
    for (const r of [...this.live]) r.close();
  }

  /** Once every segment's last write is on disk under its final name, and no cleaning runs; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.scan().values()].flat().map((s) => s.settling?.catch(() => undefined)));
    await this.cleaning;
  }

  closed(recording: Recording): void {
    this.live.delete(recording);
    void this.cleanup();
  }

  private scan(): Map<string, Segment[]> {
    if (this.index) return this.index;
    const index = new Map<string, Segment[]>();
    this.index = index;
    const root = this.options.dir;
    if (!root) return index;
    let panes: string[] = [];
    try {
      panes = fs.readdirSync(root);
    } catch {
      return index;
    }
    for (const dir of panes) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(root, dir));
      } catch {
        continue;
      }
      const segments: Segment[] = [];
      for (const name of names) {
        const m = SEGMENT_NAME.exec(name);
        if (!m) continue;
        const file = path.join(root, dir, name);
        try {
          const stat = fs.statSync(file);
          // A segment the app died writing never got its end: its last change is as good.
          segments.push({ dir, file, start: Number(m[1]), end: m[2] ? Number(m[2]) : Math.round(stat.mtimeMs), size: stat.size, open: false });
        } catch {
          // gone meanwhile
        }
      }
      if (segments.length) index.set(dir, segments.sort((a, b) => a.start - b.start));
    }
    return index;
  }

  private segmentsOf(pane: string): Segment[] {
    return this.scan().get(paneDir(pane)) ?? [];
  }

  /** Whether anything of the pane was recorded between these times. */
  has(pane: string, from: number, to: number): boolean {
    return this.segmentsOf(pane).some((s) => s.start <= to && (s.end ?? this.now()) >= from && s.size > 0);
  }

  beginSegment(pane: string, start: number): Segment | null {
    const root = this.options.dir;
    if (!root) return null;
    const dir = paneDir(pane);
    const list = this.scan().get(dir) ?? [];
    // Two segments never share a name: one begun in the same millisecond is named a moment later.
    while (list.some((s) => s.start === start)) start++;
    const seg: Segment = { dir, file: path.join(root, dir, `${start}.rec`), start, end: null, size: 0, open: true };
    this.scan().set(dir, [...list, seg].sort((a, b) => a.start - b.start));
    return seg;
  }

  forgetSegment(seg: Segment): void {
    const list = this.scan().get(seg.dir);
    if (list) this.scan().set(seg.dir, list.filter((s) => s !== seg));
  }

  async endSegment(seg: Segment, end: number): Promise<void> {
    seg.end = Math.max(end, seg.start);
    seg.open = false;
    if (!seg.size) return this.remove(seg);
    const to = path.join(path.dirname(seg.file), `${seg.start}-${seg.end}.rec`);
    const from = seg.file;
    // Known by its final name from here, so a read that follows the rename finds it; one that fails is read under the open name.
    seg.file = to;
    try {
      await fs.promises.rename(from, to);
    } catch {
      seg.file = from;
    }
  }

  private async remove(seg: Segment): Promise<void> {
    this.forgetSegment(seg);
    await seg.settling?.catch(() => undefined);
    try {
      await fs.promises.unlink(seg.file);
    } catch {
      // already gone
    }
    if (!this.scan().get(seg.dir)?.length) {
      this.scan().delete(seg.dir);
      await fs.promises.rmdir(path.dirname(seg.file)).catch(() => undefined);
    }
  }

  /** The records of the pane between these times, with the catch-up before `from`; empty when nothing was recorded. */
  async slice(pane: string, from: number, to: number, cap = REPLAY_MAX): Promise<Slice> {
    const now = this.now();
    const segments = this.segmentsOf(pane).filter((s) => s.start <= to && (s.end ?? now) >= from);
    const records: ReplayRecord[] = [];
    for (const seg of segments) {
      let data: Buffer;
      try {
        data = await fs.promises.readFile(seg.file);
      } catch (error) {
        this.options.warn(`code sessions: a recording of ${pane} could not be read: ${errorMessage(error)}`);
        continue;
      }
      const parsed = parseSegment(data);
      const start = parsed.header?.startedAt ?? seg.start;
      for (const r of parsed.records) records.push({ t: start + r.t, w: r.w, h: r.h, full: !!(r.flags & FLAG_FULL), key: !!(r.flags & FLAG_KEYFRAME), bytes: r.bytes });
    }
    return sliceOf(records, from, to, cap);
  }

  /** The oldest recordings go: past the setting's days, then while the whole takes more than its cap. Open segments stay. */
  cleanup(): Promise<void> {
    if (this.cleaning) {
      this.cleanAgain = true;
      return this.cleaning;
    }
    this.cleaning = this.cleanOnce()
      .catch((error: unknown) => this.options.warn(`code sessions: cleaning the recordings failed: ${errorMessage(error)}`))
      .finally(() => {
        this.cleaning = null;
        if (this.cleanAgain) {
          this.cleanAgain = false;
          void this.cleanup();
        }
      });
    return this.cleaning;
  }

  private async cleanOnce(): Promise<void> {
    if (!this.options.dir) return;
    const settings = this.options.settings();
    const now = this.now();
    const all = [...this.scan().values()].flat();
    const closed = all.filter((s) => !s.open).sort((a, b) => a.start - b.start);
    const oldest = now - settings.keepDays * 24 * 3600_000;
    const stale = closed.filter((s) => (s.end ?? s.start) < oldest);
    for (const seg of stale) await this.remove(seg);
    const cap = settings.maxTotalMB * 1024 * 1024;
    let total = all.reduce((n, s) => n + s.size, 0) - stale.reduce((n, s) => n + s.size, 0);
    for (const seg of closed) {
      if (total <= cap) break;
      if (stale.includes(seg)) continue;
      total -= seg.size;
      await this.remove(seg);
    }
  }
}
