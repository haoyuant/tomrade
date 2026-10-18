import { describe, expect, it } from "vitest";
import { defineWords, englishWords, installWords, wordsLocale } from "@tomradex/domain";

const words = defineWords("test", {
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
    for (const locale of ["ja", "zh-Hant", "pt-BR"]) {
      expect(words(locale).locale).toBe(locale);
      expect(words(locale)("stopped")).toBe("Stopped.");
    }
    for (const locale of ["system", undefined, null, 3]) expect(words(locale).locale).toBe("en");
    expect(words("pt-br").locale).toBe("pt-BR");
    expect(wordsLocale("zh")).toBe("zh");
    expect(wordsLocale("ja")).toBe("en");
  });

  it("refuses at compile time a translation that drops a slot or a key", () => {
    // @ts-expect-error zh lost {{title}}
    defineWords("bad-slot", { en: { a: "to {{title}}" }, zh: { a: "到" } });
    // @ts-expect-error zh lacks b
    defineWords("bad-key", { en: { a: "A", b: "B" }, zh: { a: "甲" } });
    // @ts-expect-error a template with a slot needs its value
    words("en")("switched");
  });

  it("keeps every book's English by id, for a language pack to translate", () => {
    expect(englishWords().test).toEqual({ stopped: "Stopped.", switched: "Engine switched to {{title}}.", waiting: "{{n}} waiting · {{n}} total" });
  });
});

describe("installWords", () => {
  it("speaks a pack's words, English for what it lacks or gets wrong, and stops when taken back", () => {
    const off = installWords("pt-BR", {
      test: { stopped: "Parado.", switched: "Motor trocado para {{nome}}.", gone: "Não existe." },
      elsewhere: { stopped: "Outro livro." }
    });
    const pt = words("pt-BR");
    expect(pt("stopped")).toBe("Parado.");
    // Asks for {{nome}} where English asks for {{title}}: English, filled.
    expect(pt("switched", { title: "Codex" })).toBe("Engine switched to Codex.");
    expect(pt("waiting", { n: 1 })).toBe("1 waiting · 1 total");
    expect(words("en")("stopped")).toBe("Stopped.");
    off();
    expect(words("pt-BR")("stopped")).toBe("Stopped.");
  });

  it("puts a pack before a shipped language's own words, and gives them back after", () => {
    const off = installWords("zh", { test: { stopped: "停了。" } });
    expect(words("zh")("stopped")).toBe("停了。");
    expect(words("zh")("switched", { title: "Codex" })).toBe("已切换到引擎 Codex。");
    off();
    expect(words("zh")("stopped")).toBe("已停止。");
  });
});
