import type { AccessoryAnimation, ImageBox } from "@tomradex/contributions";
import { logQuietly } from "./api";

/** The image's content box fills 96% × 90% of the canvas, bottom-centred — the desktop pet uses the same fit. */
function fit(box: ImageBox, width: number, height: number): [number, number, number, number] {
  const scale = Math.min((width * 0.96) / box.width, (height * 0.9) / box.height);
  const w = box.width * scale;
  const h = box.height * scale;
  return [(width - w) / 2, height - h, w, h];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Like browsers, a GIF delay of 10ms or less means 100ms. VideoFrame durations are microseconds. */
const frameMs = (duration: number | null) => (duration && duration > 10_000 ? duration / 1000 : 100);

/**
 * Plays one still or animated image on a canvas, each frame for its own
 * duration, one decoder at a time. Reduced motion holds the first frame.
 */
export class PetPlayer {
  private current: AccessoryAnimation | null = null;
  private stopCurrent: () => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly still: () => boolean
  ) {}

  play(animation: AccessoryAnimation): void {
    const same = (a: AccessoryAnimation) => a.source === animation.source && a.pixelated === animation.pixelated && JSON.stringify(a.box) === JSON.stringify(animation.box);
    if (this.current && same(this.current)) return;
    this.stop();
    this.current = animation;
    let stopped = false;
    this.stopCurrent = () => {
      stopped = true;
    };
    void this.run(animation, () => stopped).catch(logQuietly("pet animation"));
  }

  /** Draws the same animation again, e.g. after the canvas was resized or motion preferences changed. */
  replay(): void {
    const animation = this.current;
    this.stop();
    if (animation) this.play(animation);
  }

  stop(): void {
    this.stopCurrent();
    this.stopCurrent = () => {};
    this.current = null;
  }

  private async run(animation: AccessoryAnimation, stopped: () => boolean): Promise<void> {
    const data = await (await fetch(animation.source)).arrayBuffer();
    if (stopped()) return;
    const decoder = new ImageDecoder({ data, type: animation.type });
    try {
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack?.frameCount || 1;
      const ctx = this.canvas.getContext("2d");
      if (!ctx) return;
      let index = 0;
      let due = performance.now();
      while (!stopped()) {
        const { image } = await decoder.decode({ frameIndex: index });
        if (stopped()) {
          image.close();
          return;
        }
        const box = animation.box ?? { x: 0, y: 0, width: image.displayWidth, height: image.displayHeight };
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.imageSmoothingEnabled = !animation.pixelated;
        ctx.drawImage(image, box.x, box.y, box.width, box.height, ...fit(box, this.canvas.width, this.canvas.height));
        const ms = frameMs(image.duration);
        image.close();
        if (count === 1 || this.still()) return;
        due += ms;
        await sleep(Math.max(0, due - performance.now()));
        index = (index + 1) % count;
      }
    } finally {
      decoder.close();
    }
  }
}

export const PET_IMAGE_TYPES = ["image/gif", "image/webp", "image/png", "image/apng", "image/jpeg", "image/avif"];

/**
 * Measures the part of an image worth showing — the union of every frame's
 * visible pixels — so an image with wide transparent margins fills the stage
 * like any other. Frames are sampled small; the box is mapped back to full size.
 */
export async function measurePetImage(file: File): Promise<ImageBox | undefined> {
  const type = file.type === "image/apng" ? "image/png" : file.type;
  if (!PET_IMAGE_TYPES.includes(file.type) || !(await ImageDecoder.isTypeSupported(type))) throw new Error("unsupported");
  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type });
  try {
    await decoder.tracks.ready;
    const frames = decoder.tracks.selectedTrack?.frameCount || 1;
    let width = 0;
    let height = 0;
    let scale = 1;
    let sample: OffscreenCanvasRenderingContext2D | null = null;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < Math.min(frames, 400); i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      if (!sample) {
        width = image.displayWidth;
        height = image.displayHeight;
        scale = Math.min(1, 320 / Math.max(width, height));
        sample = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))).getContext("2d", { willReadFrequently: true });
        if (!sample) throw new Error("unsupported");
      }
      const { width: sw, height: sh } = sample.canvas;
      sample.clearRect(0, 0, sw, sh);
      sample.drawImage(image, 0, 0, sw, sh);
      image.close();
      const alpha = sample.getImageData(0, 0, sw, sh).data;
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++)
          if (alpha[(y * sw + x) * 4 + 3] > 25) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
    }
    if (x1 < 0) return undefined;
    const left = Math.max(0, Math.floor(x0 / scale));
    const top = Math.max(0, Math.floor(y0 / scale));
    const box = { x: left, y: top, width: Math.min(width, Math.ceil((x1 + 1) / scale)) - left, height: Math.min(height, Math.ceil((y1 + 1) / scale)) - top };
    // Next to nothing to trim: draw the whole image.
    return box.width * box.height >= width * height * 0.98 ? undefined : box;
  } finally {
    decoder.close();
  }
}
