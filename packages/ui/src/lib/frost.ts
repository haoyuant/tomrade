import { useEffect, useState } from "react";

/**
 * A picture drawn already frosted, once, the way Glass draws its room soft: the window then shows a
 * plain image, with no filter for the compositor to run again each time something over it changes.
 */
const baking = new Map<string, Promise<string>>();
const baked = new Map<string, string>();
// A frosted picture holds no detail finer than its blur, so a smaller copy is enough and quick to blur.
const BAKE_EDGE = 1280;

async function bake(url: string, frost: number): Promise<string> {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  try {
    const scale = Math.min(1, BAKE_EDGE / Math.max(image.width, image.height));
    const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
    // `frost` is in the window's pixels: the picture covers the window, so one of its pixels spans `cover` of them.
    const cover = Math.max(innerWidth / image.width, innerHeight / image.height);
    const blur = frost / cover * scale;
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const g = canvas.getContext("2d")!;
    g.filter = `blur(${blur}px)`;
    // Drawn past the edges, so the blur has picture to take in there and leaves no pale rim.
    const pad = Math.ceil(blur * 2);
    g.drawImage(image, -pad, -pad, width + pad * 2, height + pad * 2);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(out => out ? resolve(out) : reject(new Error("The picture could not be frosted")), "image/jpeg", 0.92));
    return URL.createObjectURL(blob);
  } finally {
    image.close();
  }
}

function frosted(url: string, frost: number): Promise<string> {
  const key = `${frost}|${url}`;
  let out = baking.get(key);
  if (!out) {
    out = bake(url, frost).then(made => { baked.set(key, made); return made; });
    baking.set(key, out);
  }
  return out;
}

/** The picture at `url` frosted by `frost` pixels: at once when it was drawn before, else null until it is. */
export function useFrosted(url: string | null, frost: number): string | null {
  const [made, setMade] = useState<{ from: string; url: string } | null>(null);
  const ready = url && frost > 0 ? baked.get(`${frost}|${url}`) : undefined;
  useEffect(() => {
    if (!url || frost <= 0 || ready) return;
    let live = true;
    // A frost slider asks for many while it moves: only the one still wanted when it pauses is drawn.
    const timer = setTimeout(() => void frosted(url, frost).then(out => { if (live) setMade({ from: url, url: out }); }, () => { if (live) setMade({ from: url, url }); }), 30);
    return () => { live = false; clearTimeout(timer); };
  }, [url, frost, ready]);
  if (!url) return null;
  if (frost <= 0) return url;
  return ready ?? (made?.from === url ? made.url : null);
}
