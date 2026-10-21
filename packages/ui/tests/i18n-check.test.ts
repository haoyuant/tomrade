import { describe, expect, it } from "vitest";
import { byNamespace, checkLocales, keyLines, parseBlame } from "../../../scripts/i18n-check.mjs";

describe("pnpm i18n:check", () => {
  it("lists missing keys, and stale ones only among the translated", () => {
    const en = { common: { save: "Save", cancel: "Cancel", close: "Close" }, about: { title: "About Tomrade" } };
    const de = { common: { save: "Speichern", cancel: "Abbrechen" } };
    expect(checkLocales(en, { de }).de).toEqual({ missing: ["common.close", "about.title"], stale: [] });
    expect(checkLocales(en, { de }, { de: new Set(["common.save", "about.title"]) }).de.stale).toEqual(["common.save"]);
  });

  it("finds the lines of each message, by path from the const that holds it", () => {
    const source = [
      "/** About: { not: a key } */",
      "export const about = {",
      "  en: {",
      '    label: "About", // a: comment',
      "    long:",
      '      "Spans {{n}} lines, with a: colon and a } brace",',
      "    \"quoted-key\": 'x'",
      "  },",
      "  zh: { label: `关于` }",
      "};"
    ].join("\n");
    expect([...keyLines(source)]).toEqual([
      ["about.en.label", [4, 4]],
      ["about.en.long", [5, 6]],
      ["about.en.quoted-key", [7, 7]],
      ["about.zh.label", [9, 9]]
    ]);
    expect(keyLines('import type { PartialMessages } from "../index";\nexport const de: PartialMessages = {\n  common: {\n    save: "Speichern"\n  }\n};').get("de.common.save")).toEqual([4, 4]);
  });

  it("reads each line's commit and time from git blame, an uncommitted line being the newest", () => {
    const sha = "a".repeat(40);
    const porcelain = [`${sha} 1 1 1`, "committer-time 100", "\tline one", `${"0".repeat(40)} 2 2 1`, "committer-time 200", "\tline two", ""].join("\n");
    expect(parseBlame(porcelain).slice(1)).toEqual([
      { commit: sha, time: 100 },
      { commit: null, time: Infinity }
    ]);
  });

  it("groups keys by namespace, most first", () => {
    expect(byNamespace(["a.x", "b.x", "b.y", "c.z"])).toBe("b 2, a 1, c 1");
  });
});
