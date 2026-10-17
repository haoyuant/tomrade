import { describe, expect, it } from "vitest";
import { en } from "../src/lib/i18n-messages";
import * as locales from "../src/lib/i18n-messages/locales";

// What the app fills in or keys off: placeholders, command chords and key glyphs.
const tokens = (text: string) => (text.match(/\{\{\s*\w+\s*\}\}|\[\[cmd:\w+\]\]|[⌃⌥⇧⌘]+\S?/g) ?? []).map((x) => x.replace(/\s/g, "")).sort();

describe.each(Object.entries(locales))("the %s translation", (_, dict) => {
  it("only names strings English has, and keeps their placeholders", () => {
    for (const [ns, entries] of Object.entries(dict)) {
      const source = (en as Record<string, Record<string, string>>)[ns];
      expect(source, ns).toBeDefined();
      for (const [key, text] of Object.entries(entries as Record<string, string>)) {
        expect(source[key], `${ns}.${key}`).toBeTypeOf("string");
        expect(tokens(text), `${ns}.${key}`).toEqual(tokens(source[key]));
      }
    }
  });
});
