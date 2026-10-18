/**
 * Languages as data. English is the source every dictionary translates: a
 * translation is a set of `namespace → key → template` entries, and an entry
 * counts only where English has the key and the template asks for the same
 * values. Everything here is pure, so the main process and the renderer
 * merge, check and pick languages the same way.
 */

/** A BCP 47 language tag: "en", "zh-Hant", "pt-BR". */
export type LanguageTag = string;

/** Templates by namespace, then key. */
export type Dictionaries = Record<string, Record<string, string>>;

const canonical = new Map<string, string | null>();

/** The tag in its canonical spelling ("pt-br" → "pt-BR"), or null when it is not a language tag. */
export function canonicalTag(tag: unknown): LanguageTag | null {
  if (typeof tag !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return null;
  let known = canonical.get(tag);
  if (known === undefined) {
    try {
      known = Intl.getCanonicalLocales(tag)[0] ?? null;
    } catch {
      known = null;
    }
    canonical.set(tag, known);
  }
  return known;
}

export const isLanguageTag = (tag: unknown): tag is LanguageTag => canonicalTag(tag) !== null;

/** Any language a person may be reading in; English for anything that is not a tag ("system", nothing at all). */
export const languageTag = (locale: unknown): LanguageTag => canonicalTag(locale) ?? "en";

// Intl names zh "Chinese"; the app's zh is the simplified script.
const NAMES: Record<string, string> = { zh: "Simplified Chinese", "zh-Hant": "Traditional Chinese" };

/** The language's English name, for a prompt's "reply in …" line: "Brazilian Portuguese". */
export function languageName(locale: unknown): string {
  const tag = languageTag(locale);
  if (NAMES[tag]) return NAMES[tag];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** What a template fills in or keys off: its `{{slot}}`s and the `[[cmd:…]]` chords the interface writes. */
export const slotsOf = (template: string): string[] =>
  [...new Set((template.match(/\{\{\s*\w+\s*\}\}|\[\[cmd:\w+\]\]/g) ?? []).map((s) => s.replace(/\s/g, "")))].sort();

export const sameSlots = (a: string, b: string): boolean => slotsOf(a).join("\0") === slotsOf(b).join("\0");

/** The entries of a translation that can stand in for English: keys English has, asking for the values its template does. */
export function usableWords(english: Dictionaries, translated: Dictionaries): Dictionaries {
  const out: Dictionaries = {};
  for (const [ns, entries] of Object.entries(translated)) {
    const source = english[ns];
    if (!source || typeof entries !== "object" || entries === null) continue;
    for (const [key, text] of Object.entries(entries)) {
      if (typeof text !== "string" || typeof source[key] !== "string" || !sameSlots(source[key], text)) continue;
      (out[ns] ??= {})[key] = text;
    }
  }
  return out;
}

export interface LanguageCoverage {
  /** Entries English has. */
  total: number;
  /** Entries translated with the slots English asks for. */
  translated: number;
  /** `namespace.key` English has and the translation does not; these read in English. */
  missing: string[];
  /** `namespace.key` the translation has and English no longer does; nothing reads them. */
  stale: string[];
  /** Entries whose template asks for other values than English's; these read in English. */
  slotMismatches: { key: string; english: string[]; translated: string[] }[];
}

/** How much of English a translation covers, and what in it nothing can use. */
export function languageCoverage(english: Dictionaries, translated: Dictionaries): LanguageCoverage {
  const out: LanguageCoverage = { total: 0, translated: 0, missing: [], stale: [], slotMismatches: [] };
  for (const [ns, entries] of Object.entries(english)) {
    for (const [key, source] of Object.entries(entries)) {
      out.total += 1;
      const text = translated[ns]?.[key];
      if (typeof text !== "string") out.missing.push(`${ns}.${key}`);
      else if (!sameSlots(source, text)) out.slotMismatches.push({ key: `${ns}.${key}`, english: slotsOf(source), translated: slotsOf(text) });
      else out.translated += 1;
    }
  }
  for (const [ns, entries] of Object.entries(translated)) {
    for (const key of Object.keys(entries ?? {})) if (typeof english[ns]?.[key] !== "string") out.stale.push(`${ns}.${key}`);
  }
  return out;
}

const parts = (tag: string): { language: string; script?: string; region?: string } | null => {
  try {
    const l = new Intl.Locale(tag).maximize();
    return { language: l.language, script: l.script, region: l.region };
  } catch {
    return null;
  }
};

/**
 * The language to show for a system that prefers `system`, among those the
 * app has: the same tag, else the same language written in the same script —
 * the system's region first, then the language's plain tag. zh-TW finds
 * zh-Hant and never zh; pt-PT finds pt-BR when that is all there is.
 */
export function pickLanguage(system: string | readonly string[] | undefined | null, available: readonly LanguageTag[]): LanguageTag | null {
  const wanted = (typeof system === "string" ? [system] : (system ?? [])).map((s) => canonicalTag(s.replace(/_/g, "-").split(".")[0])).filter((s): s is string => !!s);
  const options = available.flatMap((tag) => {
    const p = parts(tag);
    return p ? [{ tag, ...p }] : [];
  });
  for (const tag of wanted) {
    const exact = available.find((a) => a.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const want = parts(tag);
    if (!want) continue;
    const same = options.filter((o) => o.language === want.language && o.script === want.script);
    const pick = same.find((o) => o.region === want.region && o.tag.includes("-")) ?? same.find((o) => o.tag === want.language) ?? same[0];
    if (pick) return pick.tag;
  }
  return null;
}
