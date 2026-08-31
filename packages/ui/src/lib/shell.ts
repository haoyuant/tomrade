import type {} from "@tomrade/ipc";
import { invoke } from "./api";

/**
 * Channels the desktop shell implements (`apps/desktop/src/shell.ts`), declared
 * here because the renderer is their only caller and the shell is not a package
 * the UI imports. The pairing is by name, as with every other channel.
 */
declare module "@tomrade/ipc" {
  interface Channels {
    "shell.pickDirectory": (title?: string, buttonLabel?: string) => string | null;
    "shell.reveal": (target: string) => void;
    "shell.openExternal": (url: string) => void;
  }
}

/**
 * Null when the user cancels, or when there is no shell (a browser tab). `title`
 * and `buttonLabel` come from the caller already localized — the main process
 * has no renderer locale of its own to draw them from.
 */
export const pickDirectory = (title?: string, buttonLabel?: string): Promise<string | null> =>
  invoke("shell.pickDirectory", title, buttonLabel).catch(() => null);

export const reveal = (target: string): void => void invoke("shell.reveal", target).catch(() => {});

export const openExternal = (url: string): void => void invoke("shell.openExternal", url).catch(() => {});
