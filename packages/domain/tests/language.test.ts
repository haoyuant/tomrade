import { describe, expect, it } from "vitest";
import { canonicalTag, languageCoverage, languageName, pickLanguage, slotsOf, usableWords } from "@tomradex/domain";

const SHIPPED = ["en", "zh", "zh-Hant", "ja", "es", "de", "fr", "ru"];

describe("pickLanguage", () => {
  it("picks what the shipped languages always picked", () => {
    expect(pickLanguage("zh-CN", SHIPPED)).toBe("zh");
    expect(pickLanguage("zh-SG", SHIPPED)).toBe("zh");
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW"]) expect(pickLanguage(tag, SHIPPED)).toBe("zh-Hant");
    expect(pickLanguage("ja-JP", SHIPPED)).toBe("ja");
    expect(pickLanguage("es-419", SHIPPED)).toBe("es");
    expect(pickLanguage("de-CH", SHIPPED)).toBe("de");
    expect(pickLanguage("fr-CA", SHIPPED)).toBe("fr");
    expect(pickLanguage("ru-RU", SHIPPED)).toBe("ru");
    expect(pickLanguage("en-GB", SHIPPED)).toBe("en");
    expect(pickLanguage("pt-BR", SHIPPED)).toBeNull();
  });

  it("picks an installed pack when the system prefers its language", () => {
    expect(pickLanguage("pt-BR", [...SHIPPED, "pt-BR"])).toBe("pt-BR");
    expect(pickLanguage("pt-PT", [...SHIPPED, "pt-BR"])).toBe("pt-BR");
    expect(pickLanguage("pt-PT", [...SHIPPED, "pt-BR", "pt-PT"])).toBe("pt-PT");
    expect(pickLanguage("pt_BR.UTF-8", [...SHIPPED, "pt"])).toBe("pt");
    expect(pickLanguage("ko-KR", [...SHIPPED, "ko"])).toBe("ko");
    expect(pickLanguage(["xx", "ko"], [...SHIPPED, "ko"])).toBe("ko");
  });

  it("never crosses a script", () => {
    expect(pickLanguage("zh-TW", ["en", "zh"])).toBeNull();
    expect(pickLanguage("zh-CN", ["en", "zh-Hant"])).toBeNull();
    expect(pickLanguage("sr-Latn", ["en", "sr"])).toBeNull();
  });

  it("is not fooled by what is not a tag", () => {
    expect(pickLanguage(undefined, SHIPPED)).toBeNull();
    expect(pickLanguage("", SHIPPED)).toBeNull();
    expect(pickLanguage("C", SHIPPED)).toBeNull();
    expect(canonicalTag("pt-br")).toBe("pt-BR");
    expect(canonicalTag("system")).toBeNull();
    expect(canonicalTag("../x")).toBeNull();
  });
});

describe("a translation against English", () => {
  const english = {
    common: { cancel: "Cancel", closeTitled: "Close {{title}}", keys: "Press [[cmd:palette]] to search" },
    domain: { status_done: "Done" }
  };
  const pack = {
    common: { cancel: "Cancelar", closeTitled: "Fechar {{titulo}}", keys: "Pressione [[cmd:palette]] para buscar", retired: "Antigo" },
    gone: { x: "y" }
  };

  it("names the slots and chords a template asks for", () => {
    expect(slotsOf("{{ n }} of {{total}}, {{n}} again — [[cmd:undo]]")).toEqual(["[[cmd:undo]]", "{{n}}", "{{total}}"]);
    expect(slotsOf("plain")).toEqual([]);
  });

  it("keeps only what can stand in for English", () => {
    expect(usableWords(english, pack)).toEqual({ common: { cancel: "Cancelar", keys: "Pressione [[cmd:palette]] para buscar" } });
  });

  it("reports what is missing, what English no longer has, and where the values differ", () => {
    const coverage = languageCoverage(english, pack);
    expect(coverage.total).toBe(4);
    expect(coverage.translated).toBe(2);
    expect(coverage.missing).toEqual(["domain.status_done"]);
    expect(coverage.stale).toEqual(["common.retired", "gone.x"]);
    expect(coverage.slotMismatches).toEqual([{ key: "common.closeTitled", english: ["{{title}}"], translated: ["{{titulo}}"] }]);
  });

  it("names a language in English for a prompt", () => {
    expect(languageName("zh")).toBe("Simplified Chinese");
    expect(languageName("zh-Hant")).toBe("Traditional Chinese");
    expect(languageName("en")).toBe("English");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("system")).toBe("English");
  });
});
