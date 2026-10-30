import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { THEME_TYPOGRAPHY_NAMES } from "@tomradex/domain";
import type { ThemeImagePictures, ThemeImageSlot } from "@tomradex/theme-image/channels";
import { paletteOf, type ImagePalette } from "@tomradex/theme-image/colors";
import { invoke } from "./api";
import { keys } from "./queries";

/** The backdrop is kept large enough for a big display; the model sees a smaller copy. */
const BACKDROP_EDGE = 2560;
const MODEL_EDGE = 1024;

const fit = (width: number, height: number, edge: number) => { const scale = Math.min(1, edge / Math.max(width, height)); return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] as const; };
function draw(bitmap: ImageBitmap, edge: number): HTMLCanvasElement {
  const [width, height] = fit(bitmap.width, bitmap.height, edge);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}
async function encode(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The picture could not be encoded")), mime, quality));
}
const base64Of = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };

/** What a chosen picture becomes: the backdrop to keep, a copy for the model, and its palette. */
async function readPicture(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const backdrop = await encode(draw(bitmap, BACKDROP_EDGE), "image/webp", 0.9);
    const forModel = await encode(draw(bitmap, MODEL_EDGE), "image/jpeg", 0.85);
    return { backdrop, forModel, palette: paletteFrom(bitmap) };
  } finally {
    bitmap.close();
  }
}

const urls = new Map<string, string>();
function remember(key: string, blob: Blob): string {
  const previous = urls.get(key);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

/** The picture behind a custom theme in one window, as a URL the page can draw; null when this machine does not have it. */
export function useThemeImageUrl(themeId: string | null, slot: ThemeImageSlot = "main") {
  return useQuery({
    queryKey: keys.themeImage(themeId ?? "", slot),
    enabled: !!themeId,
    staleTime: Infinity,
    queryFn: async () => {
      const image = await invoke("themeImage.read", themeId!, slot).catch(() => null);
      if (!image) return null;
      const bytes = Uint8Array.from(atob(image.base64), char => char.charCodeAt(0));
      return remember(`${themeId}:${slot}`, new Blob([bytes], { type: image.mime }));
    }
  }).data ?? null;
}

export interface ThemeFromImageRequest {
  /** Behind Tomrade's window; the colours come from it. */
  main: File;
  /** Behind the Terminal window, or none. */
  terminal: File | null;
  /** Read by the assistant in a conversation, or from the picture's own palette at once. */
  ai: boolean;
  frost: number;
  /** The conversation's project, when Settings is open in one. */
  projectId?: string;
}
/** A conversation took the picture, or the theme was made from its own colours (`fellBack`: the assistant could not see it). */
export type ThemeFromImageOutcome = { conversation: true } | { conversation: false; name: string; fellBack: boolean };

const paletteFrom = (bitmap: ImageBitmap) => { const small = draw(bitmap, 64); return paletteOf(small.getContext("2d")!.getImageData(0, 0, small.width, small.height).data); };
/** A picture for behind a window: the backdrop to keep, and its palette. */
const backdropOf = async (file: File) => {
  const bitmap = await createImageBitmap(file);
  try { return { backdrop: await encode(draw(bitmap, BACKDROP_EDGE), "image/webp", 0.9), palette: paletteFrom(bitmap) }; } finally { bitmap.close(); }
};

/** Making a theme from pictures, and putting other pictures behind an existing one. */
export function useThemeFromImage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const keep = useCallback(async (themeId: string, backdrop: Blob, slot: ThemeImageSlot) => {
    await invoke("themeImage.save", themeId, { base64: await base64Of(backdrop) }, slot);
    qc.setQueryData(keys.themeImage(themeId, slot), remember(`${themeId}:${slot}`, backdrop));
  }, [qc]);

  const create = useCallback(async ({ main, terminal, ai, frost, projectId }: ThemeFromImageRequest): Promise<ThemeFromImageOutcome> => {
    setBusy(true);
    try {
      const { backdrop, forModel, palette } = await readPicture(main);
      const behindTerminal = terminal && await backdropOf(terminal);
      const styles = getComputedStyle(document.documentElement);
      const pictures: ThemeImagePictures = {
        main: { base64: await base64Of(backdrop) }, ...(behindTerminal ? { terminal: { base64: await base64Of(behindTerminal.backdrop) }, terminalPalette: behindTerminal.palette } : {}),
        palette, frost, fallbackName: main.name.replace(/\.[^.]+$/, "") || main.name,
        fonts: Object.fromEntries(THEME_TYPOGRAPHY_NAMES.map(name => [name, styles.getPropertyValue(`--${name}`).trim()]))
      };
      if (ai && await invoke("themeImage.start", { ...pictures, projectId, view: { mime: "image/jpeg", base64: await base64Of(forModel) } })) return { conversation: true };
      return { conversation: false, name: (await invoke("themeImage.local", pictures)).name, fellBack: ai };
    } finally {
      setBusy(false);
    }
  }, []);

  /** Resolves to the new picture's palette, for the veil over it. */
  const replace = useCallback(async (themeId: string, file: File, slot: ThemeImageSlot): Promise<ImagePalette> => {
    setBusy(true);
    try {
      const { backdrop, palette } = await backdropOf(file);
      await keep(themeId, backdrop, slot);
      return palette;
    } finally {
      setBusy(false);
    }
  }, [keep]);

  const clear = useCallback(async (themeId: string, slot: ThemeImageSlot) => {
    await invoke("themeImage.remove", themeId, slot);
    qc.setQueryData(keys.themeImage(themeId, slot), null);
  }, [qc]);

  return { create, replace, clear, busy };
}
