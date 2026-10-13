import type {} from "@tomradex/ipc";
import { invoke } from "./api";

export interface AboutInfo {
  version: string;
  /** False for a checkout, which updates from git rather than from releases. */
  packaged: boolean;
  commit: string | null;
  builtAt: string | null;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  os: string;
  arch: string;
  userData: string;
}

/**
 * Channels the desktop shell implements (`apps/desktop/src/shell.ts`), declared
 * here because the renderer is their only caller and the shell is not a package
 * the UI imports. The pairing is by name, as with every other channel.
 */
declare module "@tomradex/ipc" {
  interface Channels {
    "shell.pickDirectory": (title?: string, buttonLabel?: string) => string | null;
    /** Native picker for several files, or for folders. Null when the user cancels. */
    "shell.pickFiles": (title?: string, buttonLabel?: string, kind?: "files" | "folders") => string[] | null;
    "shell.pickProgram": (title?: string, buttonLabel?: string) => string | null;
    "shell.reveal": (target: string) => void;
    "shell.openExternal": (url: string) => void;
    "shell.about": () => AboutInfo;
    /** Native save dialog, then the text written there. The chosen path, or null when cancelled. */
    "shell.saveTextFile": (opts: { title?: string; defaultName: string; text: string }) => string | null;
    /** Native open dialog for one text file, read back. Null when cancelled. */
    "shell.openTextFile": (opts: { title?: string; extensions?: string[] }) => { path: string; text: string } | null;
  }
}

/**
 * Null when the user cancels, or when there is no shell (a browser tab). `title`
 * and `buttonLabel` come from the caller already localized — the main process
 * has no renderer locale of its own to draw them from.
 */
export const pickDirectory = (title?: string, buttonLabel?: string): Promise<string | null> =>
  invoke("shell.pickDirectory", title, buttonLabel).catch(() => null);

export const pickFiles = (title?: string, buttonLabel?: string, kind: "files" | "folders" = "files"): Promise<string[] | null> =>
  invoke("shell.pickFiles", title, buttonLabel, kind).catch(() => null);

export const pickProgram = (title?: string, buttonLabel?: string): Promise<string | null> =>
  invoke("shell.pickProgram", title, buttonLabel).catch(() => null);

export const reveal = (target: string): void => void invoke("shell.reveal", target).catch(() => {});

export const openExternal = (url: string): void => void invoke("shell.openExternal", url).catch(() => {});

/** Null in a browser tab, or for a File the OS drag never backed with a real path. */
export const pathForFile = (file: File): string | null => {
  try {
    return window.tomrade.getPathForFile(file) || null;
  } catch {
    return null;
  }
};
