import type {} from "cordis";
import type {} from "@tomradex/ipc";
import type { ImagePalette } from "./colors.js";

/* The plugin's channels, with nothing of Node: the renderer imports them as they are. */

export interface ThemeImage { mime: string; base64: string }
/** Which window the picture is behind: Tomrade's own, or the Terminal window. */
export type ThemeImageSlot = "main" | "terminal";
export const SLOTS: ThemeImageSlot[] = ["main", "terminal"];
/** What the renderer read off the pictures; the theme is made from it here, by a conversation or on the spot. */
export interface ThemeImagePictures {
  /** Behind Tomrade's window, and the Terminal window's when there is one. */
  main: { base64: string };
  terminal?: { base64: string };
  palette: ImagePalette;
  terminalPalette?: ImagePalette;
  frost: number;
  /** The typography the theme starts from, as the page computes it. */
  fonts: Record<string, string>;
  fallbackName: string;
}
/** A conversation reads the picture: `view` is the copy it looks at. */
export interface ThemeImageStart extends ThemeImagePictures {
  /** The conversation's project; absent, the latest one. */
  projectId?: string;
  view: ThemeImage;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "themeImage.read": (themeId: string, slot?: ThemeImageSlot) => ThemeImage | null;
    "themeImage.save": (themeId: string, image: { base64: string }, slot?: ThemeImageSlot) => { mime: string; bytes: number };
    "themeImage.remove": (themeId: string, slot: ThemeImageSlot) => void;
    /** Null when the assistant's model or agent cannot see pictures: nothing is started. */
    "themeImage.start": (request: ThemeImageStart) => { projectId: string; threadId: string } | null;
    /** The theme from the picture's own colours, made at once. */
    "themeImage.local": (request: ThemeImagePictures) => { name: string };
  }
}

