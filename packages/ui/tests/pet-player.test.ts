import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PetPlayer } from "../src/lib/petPlayer";

const FRAMES = 3;
const FRAME_US = 50_000;
let decoded: number[];
let closedDecoders: number;
let closedBitmaps: number;

beforeEach(() => {
  vi.useFakeTimers();
  decoded = [];
  closedDecoders = 0;
  closedBitmaps = 0;
  vi.stubGlobal("fetch", async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }));
  vi.stubGlobal(
    "ImageDecoder",
    class {
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: FRAMES } };
      async decode({ frameIndex }: { frameIndex: number }) {
        decoded.push(frameIndex);
        return { image: { displayWidth: 40, displayHeight: 30, duration: FRAME_US, frame: frameIndex, close() {} } };
      }
      close() {
        closedDecoders++;
      }
    }
  );
  vi.stubGlobal("createImageBitmap", async (image: { frame: number }) => ({ frame: image.frame, close: () => closedBitmaps++ }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stage = () => {
  const drawn: number[] = [];
  const ctx = { clearRect() {}, drawImage: (bitmap: { frame: number }) => drawn.push(bitmap.frame) };
  const canvas = { width: 100, height: 80, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, drawn };
};
const animation = { source: "pet://idle.webp", type: "image/webp" };

it("decodes each frame once and draws it from memory on every loop after", async () => {
  const { canvas, drawn } = stage();
  const player = new PetPlayer(canvas, () => false);
  player.play(animation);
  await vi.advanceTimersByTimeAsync(FRAMES * 2 * (FRAME_US / 1000));
  expect(drawn.slice(0, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
  expect(decoded).toEqual([0, 1, 2]);
  player.stop();
});

it("draws nothing while hidden and goes on from its frame once shown", async () => {
  const { canvas, drawn } = stage();
  const player = new PetPlayer(canvas, () => false);
  player.play(animation);
  await vi.advanceTimersByTimeAsync(10);
  player.show(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(drawn).toEqual([0]);
  player.show(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(drawn).toEqual([0, 1]);
  player.stop();
});

it("lets go of its decoder and frames when stopped while hidden", async () => {
  const { canvas } = stage();
  const player = new PetPlayer(canvas, () => false);
  player.play(animation);
  await vi.advanceTimersByTimeAsync(FRAMES * (FRAME_US / 1000));
  player.show(false);
  await vi.advanceTimersByTimeAsync(FRAME_US / 1000);
  player.stop();
  await vi.advanceTimersByTimeAsync(10);
  expect(closedDecoders).toBe(1);
  expect(closedBitmaps).toBe(FRAMES);
});

it("holds the first frame under reduced motion", async () => {
  const { canvas, drawn } = stage();
  const player = new PetPlayer(canvas, () => true);
  player.play(animation);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(drawn).toEqual([0]);
  expect(decoded).toEqual([0]);
});
