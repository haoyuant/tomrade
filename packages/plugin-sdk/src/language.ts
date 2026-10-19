import { z } from "zod";
import { canonicalTag, pickLanguage, type Dictionaries } from "@tomradex/domain";
import type { Locale } from "./contract.js";

export { languageCoverage, pickLanguage, slotsOf, type Dictionaries, type LanguageCoverage } from "@tomradex/domain";

/**
 * A plugin's own words in the app's language (`ctx.settings.locale()`): the
 * closest language it has, picked as Tomrade picks its own (zh-TW finds
 * zh-Hant, never zh), and English when it has none of that language.
 */
export function wordsFor<T>(locale: Locale, words: { en: T } & Partial<Record<Locale, T>>): T {
  return words[pickLanguage(locale, Object.keys(words)) ?? "en"] ?? words.en;
}

/**
 * A language pack: data only. The manifest names each language a plugin adds
 * and the JSON file holding its words; nothing in it runs, and every string
 * is shown as plain text in place of the English it translates.
 */

/** The largest pack file Tomrade reads, and the longest single template. */
export const LANGUAGE_PACK_LIMITS = { fileBytes: 2 * 1024 * 1024, templateChars: 4_000, languages: 16 };

export const LanguageEntrySchema = z.object({
  /** A BCP 47 tag: "pt-BR", "ko", "zh-Hant". */
  tag: z
    .string()
    .refine((t) => canonicalTag(t) === t, "a canonical BCP 47 language tag such as \"pt-BR\" or \"ko\"")
    .refine((t) => t !== "en", "English is what every pack translates; it cannot be replaced"),
  /** The language's name in itself, as Settings → Language lists it: "Português (Brasil)". */
  name: z.string().trim().min(1).max(60),
  /** The pack's words, a JSON file inside the plugin: "languages/pt-BR.json". */
  file: z
    .string()
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]*\.json$/, "a relative path to a .json file inside the plugin")
    .refine((f) => !f.split("/").includes(".."), "the file must stay inside the plugin")
});

export type LanguageEntry = z.output<typeof LanguageEntrySchema>;

const Words = z.record(z.string().min(1), z.record(z.string().min(1), z.string().max(LANGUAGE_PACK_LIMITS.templateChars)));

/**
 * What a pack file holds: `ui` translates the interface's dictionaries,
 * `backend` the backend's books, each `namespace → key → template`, keyed as
 * English is. A template names its values as `{{slot}}`, exactly the slots
 * English's does; an entry that does not, or a key English lacks, reads English.
 */
export const LanguagePackFileSchema = z
  .object({
    ui: Words.default({}),
    backend: Words.default({})
  })
  .strict();

export interface LanguagePack {
  tag: string;
  name: string;
  ui: Dictionaries;
  backend: Dictionaries;
}

/** A pack file's text checked against the format; throws with the first problem. */
export function parseLanguagePack(entry: LanguageEntry, text: string): LanguagePack {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${entry.file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = LanguagePackFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${entry.file} ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { tag: entry.tag, name: entry.name, ui: parsed.data.ui, backend: parsed.data.backend };
}
