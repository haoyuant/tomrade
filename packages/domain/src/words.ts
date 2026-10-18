import { languageTag, sameSlots, type Dictionaries, type LanguageTag } from "./language.js";

/**
 * What the backend says to a person, kept as one book of templates per
 * package. A template names its values as {{slot}}; the code picks which
 * template to use and fills it, so a translation is data and nothing more.
 * Prompts written for an agent are not words: they stay in code, in English.
 */

/** The languages Tomrade's own code writes in, each complete. Any other language reads English, or what an installed language pack brings. */
export type WordsLocale = "en" | "zh";

export const wordsLocale = (locale: unknown): WordsLocale => (locale === "zh" ? "zh" : "en");

/** The `{{slot}}` names a template asks for. */
export type Slots<S extends string> = S extends `${string}{{${infer V}}}${infer R}` ? V | Slots<R> : never;

type Fill<S extends string> = [Slots<S>] extends [never] ? [] : [vars: Record<Slots<S>, string | number>];

type SameSlots<A extends string, B extends string> = [Slots<A>] extends [Slots<B>] ? ([Slots<B>] extends [Slots<A>] ? true : false) : false;

/** Each translation is complete and names exactly the slots its English does. */
type Translation<E extends Record<string, string>, Z> = {
  [K in keyof E]: K extends keyof Z ? (Z[K] extends string ? (SameSlots<E[K], Z[K]> extends true ? Z[K] : `slots differ from en: ${E[K]}`) : string) : string;
};

export interface Speak<E extends Record<string, string>> {
  <K extends keyof E & string>(key: K, ...vars: Fill<E[K]>): string;
  /** The language asked for; a word it lacks reads English. */
  readonly locale: LanguageTag;
}

export type WordBook<E extends Record<string, string>> = (locale: unknown) => Speak<E>;

export const fillSlots = (template: string, vars?: Record<string, string | number>): string =>
  vars ? template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? "")) : template;

/** Every book's English, by id: what a language pack translates. */
const english = new Map<string, Record<string, string>>();
/** Language → book → key: what installed language packs bring, each layer kept apart so one can be taken back. */
const packs = new Map<LanguageTag, Dictionaries[]>();

export function defineWords<const E extends Record<string, string>, const Z extends Record<string, string>>(id: string, book: { en: E; zh: Z & Translation<E, Z> }): WordBook<E> {
  english.set(id, book.en);
  const zh: Record<string, string> = book.zh;
  return (locale) => {
    const lang = languageTag(locale);
    const speak = (key: string, vars?: Record<string, string | number>) => {
      const source: string | undefined = book.en[key];
      let text: string | undefined;
      // A pack's entry stands in only for a key English has, asking for the same values.
      for (const layer of packs.get(lang) ?? []) {
        const said = layer[id]?.[key];
        if (text === undefined && source !== undefined && typeof said === "string" && sameSlots(source, said)) text = said;
      }
      return fillSlots(text ?? (lang === "zh" ? zh[key] : undefined) ?? source ?? key, vars);
    };
    return Object.assign(speak, { locale: lang }) as Speak<E>;
  };
}

/** The English of every book defined so far, keyed by book id. */
export const englishWords = (): Dictionaries => Object.fromEntries(english);

/**
 * A language pack's words for the backend's books, spoken from now on. An
 * entry English lacks, or one asking for other slots, reads English. The
 * pack installed last speaks first. Returns the undo.
 */
export function installWords(locale: LanguageTag, books: Dictionaries): () => void {
  const tag = languageTag(locale);
  packs.set(tag, [books, ...(packs.get(tag) ?? [])]);
  return () => {
    const rest = (packs.get(tag) ?? []).filter((l) => l !== books);
    if (rest.length) packs.set(tag, rest);
    else packs.delete(tag);
  };
}
