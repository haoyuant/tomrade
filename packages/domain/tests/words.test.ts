import { describe, expect, it } from "vitest";
import { defineWords, wordsLocale } from "@tomradex/domain";

const words = defineWords({
  en: { stopped: "Stopped.", switched: "Engine switched to {{title}}.", waiting: "{{n}} waiting · {{n}} total" },
  zh: { stopped: "已停止。", switched: "已切换到引擎 {{title}}。", waiting: "{{n}} 个在等 · 共 {{n}} 个" }
});

describe("defineWords", () => {
  it("speaks the language asked for, filling every slot", () => {
    expect(words("zh")("switched", { title: "Codex" })).toBe("已切换到引擎 Codex。");
    expect(words("en")("waiting", { n: 2 })).toBe("2 waiting · 2 total");
    expect(words("zh")("stopped")).toBe("已停止。");
  });

  it("reads English for any language without its own words", () => {
    for (const locale of ["ja", "zh-Hant", "system", undefined, null, 3]) {
      expect(words(locale).locale).toBe("en");
      expect(words(locale)("stopped")).toBe("Stopped.");
    }
    expect(wordsLocale("zh")).toBe("zh");
  });

  it("refuses at compile time a translation that drops a slot or a key", () => {
    // @ts-expect-error zh lost {{title}}
    defineWords({ en: { a: "to {{title}}" }, zh: { a: "到" } });
    // @ts-expect-error zh lacks b
    defineWords({ en: { a: "A", b: "B" }, zh: { a: "甲" } });
    // @ts-expect-error a template with a slot needs its value
    words("en")("switched");
  });
});
