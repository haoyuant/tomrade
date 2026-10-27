import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { FLAG_FULL, FLAG_GAP, FLAG_KEYFRAME, HOLD_MAX, HOLD_MS, paneDir, parseSegment, RECORD_HEAD, Recorder, RecordingSettings, SEGMENT_MAX, sliceOf, type ReplayRecord } from "../src/recorder.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-recorder-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let dirs = 0;
const fresh = (over: Partial<RecordingSettings> = {}, dir: string | null = path.join(root, `r${++dirs}`)) => {
  const clock = { now: 1_000_000 };
  const warnings: string[] = [];
  const recorder = new Recorder({ dir, settings: () => ({ ...RecordingSettings.parse({}), ...over }), warn: (m) => warnings.push(m), now: () => clock.now });
  return { recorder, clock, warnings, dir };
};
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const text = (r: { bytes: Uint8Array }) => Buffer.from(r.bytes).toString();
const files = (dir: string, pane: string) => fs.readdirSync(path.join(dir, paneDir(pane))).sort();
const hooks = () => ({ asked: 0, warned: [] as string[], needKeyframe() { this.asked++; }, warn(reason: string) { this.warned.push(reason); } });

it("records a cell's frames as one stretch, named for when it began and ended, and plays a session's part back by its time", async () => {
  const { recorder, clock, dir } = fresh();
  const h = hooks();
  const rec = recorder.open("w1:p1", h)!;
  rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: bytes("first") });
  clock.now += 500;
  rec.write({ seq: 2, width: 80, height: 24, full: false, bytes: bytes("second") });
  clock.now += 500;
  rec.write({ seq: 3, width: 80, height: 24, full: false, bytes: bytes("third") });
  clock.now += 200;
  rec.close();
  await recorder.settled();
  expect(files(dir, "w1:p1")).toEqual(["1000000-1001200.rec"]);
  const parsed = parseSegment(fs.readFileSync(path.join(dir, "w1_p1", "1000000-1001200.rec")));
  expect(parsed.header).toEqual({ v: 1, pane: "w1:p1", startedAt: 1_000_000, cols: 80, rows: 24 });
  expect(parsed.records.map((r) => [r.t, r.flags, text(r)])).toEqual([[0, FLAG_FULL, "first"], [500, 0, "second"], [1000, 0, "third"]]);
  // A session that began mid-stretch: the whole-screen paint before it catches up unseen, and what came after its end is not sent.
  expect(recorder.has("w1:p1", 1_000_400, 1_000_600)).toBe(true);
  expect(recorder.has("w1:p1", 1_002_000, 1_003_000)).toBe(false);
  expect(recorder.has("w9:p9", 0, 2_000_000)).toBe(false);
  const slice = await recorder.slice("w1:p1", 1_000_400, 1_000_600);
  expect(slice.records.map((r) => [r.t, r.full, r.key, text(r)])).toEqual([[1_000_000, true, false, "first"], [1_000_500, false, false, "second"]]);
  expect(slice).toMatchObject({ at: 1, cut: false, clean: true });
  // The folder is read afresh by another recorder: what one run wrote, the next one plays back.
  const again = new Recorder({ dir, settings: () => RecordingSettings.parse({}), warn: () => undefined });
  expect(again.has("w1:p1", 1_000_000, 1_000_001)).toBe(true);
  expect((await again.slice("w1:p1", 1_000_000, 1_002_000)).records).toHaveLength(3);
});

it("a snapshot from the window ends the stretch and begins the next with it: frames up to its seq before, the rest after", async () => {
  const { recorder, clock, dir } = fresh();
  const rec = recorder.open("w1:p2", hooks())!;
  rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: bytes("a") });
  clock.now += 100;
  const token = rec.hold();
  // Held while the window answers; the same hold answers a second ask.
  expect(rec.hold()).toBe(token);
  rec.write({ seq: 2, width: 80, height: 24, full: false, bytes: bytes("b") });
  rec.write({ seq: 3, width: 80, height: 24, full: false, bytes: bytes("c") });
  // An answer to an ask that is not this one changes nothing.
  rec.keyframe(token + 7, 3, 80, 24, bytes("stale"));
  clock.now += 100;
  rec.keyframe(token, 2, 80, 24, bytes("SNAP"));
  rec.write({ seq: 4, width: 80, height: 24, full: false, bytes: bytes("d") });
  rec.close();
  await recorder.settled();
  const names = files(dir, "w1:p2");
  expect(names).toEqual(["1000000-1000200.rec", "1000200-1000200.rec"]);
  const read = (name: string) => parseSegment(fs.readFileSync(path.join(dir, "w1_p2", name))).records.map((r) => [r.flags, text(r)]);
  expect(read(names[0]!)).toEqual([[FLAG_FULL, "a"], [0, "b"]]);
  expect(read(names[1]!)).toEqual([[FLAG_FULL | FLAG_KEYFRAME, "SNAP"], [0, "c"], [0, "d"]]);
  // A session beginning at the snapshot replays from it, nothing before.
  const slice = await recorder.slice("w1:p2", 1_000_200, 1_000_300);
  expect(slice.records.map((r) => [r.key, text(r)])).toEqual([[true, "SNAP"], [false, "c"], [false, "d"]]);
  expect(slice).toMatchObject({ at: 0, clean: true, cut: false });
});

it("frames held for a snapshot that never comes go into the open stretch after a moment, and past HOLD_MAX at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { recorder, dir } = fresh();
    const rec = recorder.open("w1:p3", hooks())!;
    rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: bytes("a") });
    rec.hold();
    rec.write({ seq: 2, width: 80, height: 24, full: false, bytes: bytes("b") });
    vi.advanceTimersByTime(HOLD_MS);
    rec.write({ seq: 3, width: 80, height: 24, full: false, bytes: bytes("c") });
    // Too much to hold: written as it is, and the late snapshot is not taken.
    const token = rec.hold();
    rec.write({ seq: 4, width: 80, height: 24, full: false, bytes: new Uint8Array(HOLD_MAX + 1) });
    rec.keyframe(token, 4, 80, 24, bytes("late"));
    rec.close();
    vi.useRealTimers();
    await recorder.settled();
    const names = files(dir, "w1:p3");
    expect(names).toHaveLength(1);
    const records = parseSegment(fs.readFileSync(path.join(dir, "w1_p3", names[0]!))).records;
    expect(records.map((r) => [r.flags, r.bytes.length])).toEqual([[FLAG_FULL, 1], [0, 1], [0, 1], [0, HOLD_MAX + 1]]);
  } finally {
    vi.useRealTimers();
  }
});

it("a stretch past SEGMENT_MAX asks the window for a snapshot once, and a frame the disk has no room for is dropped and the next one says so", async () => {
  const { recorder, dir } = fresh();
  const h = hooks();
  const rec = recorder.open("w1:p4", h)!;
  rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: new Uint8Array(SEGMENT_MAX) });
  // Still queued for the disk: this one has no room.
  rec.write({ seq: 2, width: 80, height: 24, full: false, bytes: bytes("dropped") });
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.asked).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  rec.write({ seq: 3, width: 80, height: 24, full: false, bytes: bytes("after gap") });
  expect(h.asked).toBe(1);
  rec.close();
  await recorder.settled();
  const names = files(dir, "w1:p4");
  const records = parseSegment(fs.readFileSync(path.join(dir, "w1_p4", names[0]!))).records;
  expect(records.map((r) => [r.flags, r.bytes.length])).toEqual([[FLAG_FULL, SEGMENT_MAX], [FLAG_GAP, 9]]);
});

it("reads what it can of a file cut off mid-record, and takes a stretch never closed to end at its last change", async () => {
  const { recorder, dir } = fresh();
  const pane = path.join(dir, paneDir("w1:p5"));
  fs.mkdirSync(pane, { recursive: true });
  const head = Buffer.alloc(RECORD_HEAD);
  head.writeUInt32BE(10, 0);
  head.writeUInt16BE(80, 4);
  head.writeUInt16BE(24, 6);
  head.writeUInt8(FLAG_FULL, 8);
  head.writeUInt32BE(5, 9);
  const whole = Buffer.concat([Buffer.from(`${JSON.stringify({ v: 1, pane: "w1:p5", startedAt: 5000, cols: 80, rows: 24 })}\n`), head, Buffer.from("hello"), head, Buffer.from("hel")]);
  fs.writeFileSync(path.join(pane, "5000.rec"), whole);
  const at = new Date(9000);
  fs.utimesSync(path.join(pane, "5000.rec"), at, at);
  expect(parseSegment(whole).records.map(text)).toEqual(["hello"]);
  expect(parseSegment(Buffer.from("not json\n")).header).toBeNull();
  expect(recorder.has("w1:p5", 8000, 8500)).toBe(true);
  expect(recorder.has("w1:p5", 9500, 9900)).toBe(false);
  expect((await recorder.slice("w1:p5", 5000, 6000)).records.map((r) => [r.t, text(r)])).toEqual([[5010, "hello"]]);
});

it("drops recordings past the days kept, then the oldest while the whole is over the cap; what is open stays", async () => {
  const { recorder, clock, dir } = fresh({ keepDays: 1, maxTotalMB: 64 });
  const pane = path.join(dir, paneDir("w1:p6"));
  fs.mkdirSync(pane, { recursive: true });
  const day = 24 * 3600_000;
  const seg = (start: number, end: number, mb: number) => {
    const file = path.join(pane, `${start}-${end}.rec`);
    fs.writeFileSync(file, "");
    fs.truncateSync(file, mb * 1024 * 1024);
  };
  clock.now = 10 * day;
  seg(7 * day, 7 * day + 1000, 10); // past the day kept
  seg(9 * day, 9 * day + 1000, 30);
  seg(9 * day + 2000, 9 * day + 3000, 30);
  seg(9 * day + 4000, 9 * day + 5000, 30); // the three together are over 64 MB: the oldest of them goes
  const rec = recorder.open("w1:p6", hooks())!;
  rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: bytes("open") });
  await recorder.cleanup();
  expect(fs.readdirSync(pane).sort()).toEqual([`${9 * day + 2000}-${9 * day + 3000}.rec`, `${9 * day + 4000}-${9 * day + 5000}.rec`, `${10 * day}.rec`]);
  rec.close();
  await recorder.settled();
  // The pane's folder goes with its last recording.
  const tidy = new Recorder({ dir, settings: () => ({ enabled: true, keepDays: 1, maxTotalMB: 64 }), warn: () => undefined, now: () => 20 * day });
  await tidy.cleanup();
  expect(fs.existsSync(pane)).toBe(false);
});

it("records nothing without a folder or with the setting off, and a folder that cannot be written is said once and the cell goes on", async () => {
  expect(fresh({}, null).recorder.open("w1:p7", hooks())).toBeNull();
  expect(fresh({ enabled: false }).recorder.open("w1:p7", hooks())).toBeNull();
  const blocked = path.join(root, "not-a-folder");
  fs.writeFileSync(blocked, "a file where the recordings folder would be");
  const { recorder } = fresh({}, blocked);
  const h = hooks();
  const rec = recorder.open("w1:p7", h)!;
  rec.write({ seq: 1, width: 80, height: 24, full: true, bytes: bytes("a") });
  rec.write({ seq: 2, width: 80, height: 24, full: false, bytes: bytes("b") });
  expect(h.warned).toHaveLength(1);
  expect(rec.closed).toBe(true);
  rec.close();
  await recorder.settled();
  expect((await recorder.slice("w1:p7", 0, 2_000_000)).records).toEqual([]);
});

it("over the cap a slice loses its start: to the whole-screen paint that fits, else to what fits, and says so", () => {
  const r = (t: number, full: boolean, size: number): ReplayRecord => ({ t, w: 80, h: 24, full, key: false, bytes: new Uint8Array(size) });
  const records = [r(0, true, 10), r(10, false, 10), r(20, true, 10), r(30, false, 10), r(40, false, 10)];
  // Fits: the catch-up starts at the last whole-screen paint before `from`.
  expect(sliceOf(records, 25, 35, 100)).toMatchObject({ at: 1, cut: false, clean: true });
  expect(sliceOf(records, 25, 35, 100).records.map((x) => x.t)).toEqual([20, 30]);
  // Over the cap from a point inside the session: the whole-screen paint at 20 keeps the picture right, the start is gone.
  expect(sliceOf(records, 5, 40, 30)).toMatchObject({ at: 0, cut: true, clean: true });
  expect(sliceOf(records, 5, 40, 30).records.map((x) => x.t)).toEqual([20, 30, 40]);
  // No whole-screen paint fits: as far back as fits, and the replay fills in.
  const plain = [r(0, true, 10), r(10, false, 10), r(20, false, 10), r(30, false, 10)];
  expect(sliceOf(plain, 0, 30, 25)).toMatchObject({ at: 0, cut: true, clean: false });
  expect(sliceOf(plain, 0, 30, 25).records.map((x) => x.t)).toEqual([20, 30]);
  expect(sliceOf([], 0, 10)).toEqual({ records: [], at: 0, cut: false, clean: false });
});
