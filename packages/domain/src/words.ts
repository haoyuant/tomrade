/**
 * What the backend says to a person, kept as one book of templates per
 * package. A template names its values as {{slot}}; the code picks which
 * template to use and fills it, so a translation is data and nothing more.
 * Prompts written for an agent are not words: they stay in code, in English.
 */

/** The languages the backend writes in. Any other language reads English here. */
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
  readonly locale: WordsLocale;
}

export type WordBook<E extends Record<string, string>> = (locale: unknown) => Speak<E>;

export const fillSlots = (template: string, vars?: Record<string, string | number>): string =>
  vars ? template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? "")) : template;

export function defineWords<const E extends Record<string, string>, const Z extends Record<string, string>>(book: { en: E; zh: Z & Translation<E, Z> }): WordBook<E> {
  const dicts: Record<WordsLocale, Record<string, string>> = book;
  return (locale) => {
    const lang = wordsLocale(locale);
    const speak = (key: string, vars?: Record<string, string | number>) => fillSlots(dicts[lang][key] ?? dicts.en[key] ?? key, vars);
    return Object.assign(speak, { locale: lang }) as Speak<E>;
  };
}
