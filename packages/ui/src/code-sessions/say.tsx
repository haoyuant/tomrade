import { createContext, useContext } from "react";
import { interpolate, message } from "~/lib/dicts";
import type { codeSessions } from "~/lib/i18n-messages/codeSessions";

export type SayKey = keyof typeof codeSessions.en;
export type Say = (key: SayKey, vars?: Record<string, string | number>) => string;

export const sayIn =
  (locale: string): Say =>
  (key, vars) =>
    interpolate(message(locale, `codeSessions.${key}`), vars);

/** The window's words in its language, for every part of it without passing them down. */
export const SayContext = createContext<Say>(sayIn("en"));

export const useSay = (): Say => useContext(SayContext);

/** Any of the app's words in the window's language: what the main window says the same way (an outcome, a span of time). */
export type Words = (key: string, vars?: Record<string, string | number>) => string;

export const wordsIn =
  (locale: string): Words =>
  (key, vars) =>
    interpolate(message(locale, key), vars);

export const WordsContext = createContext<Words>(wordsIn("en"));

export const useWords = (): Words => useContext(WordsContext);
