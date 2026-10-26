import { afterEach, describe, expect, it } from "vitest";
import { loadLocale, localeLoaded, message, say, setPackMessages } from "../src/lib/dicts";
import { en } from "../src/lib/i18n-messages";

afterEach(() => setPackMessages(null, null));

describe("a language pack in the interface", () => {
  it("speaks the pack's words, and English for any it lacks or gets wrong", () => {
    setPackMessages("pt-BR", { common: { cancel: "Cancelar", closeTitled: "Fechar {{titulo}}", retired: "Antigo" }, nowhere: { x: "y" } });
    expect(say("pt-BR", "common.cancel")).toBe("Cancelar");
    // Asks for {{titulo}} where English asks for {{title}}: English, filled.
    expect(say("pt-BR", "common.closeTitled", { title: "Notas" })).toBe("Close Notas");
    expect(say("pt-BR", "common.save")).toBe("Save");
    expect(message("pt-BR", "common.retired")).toBe("common.retired");
    // Another language never reads the pack.
    expect(say("en", "common.cancel")).toBe("Cancel");
  });

  it("speaks before a shipped language's own words, which come back once it goes", async () => {
    await loadLocale("ja");
    const shipped = say("ja", "common.cancel");
    setPackMessages("ja", { common: { cancel: "取消し" } });
    expect(say("ja", "common.cancel")).toBe("取消し");
    expect(say("ja", "common.save")).toBe("保存");
    setPackMessages(null, null);
    expect(say("ja", "common.cancel")).toBe(shipped);
  });

  it("shows English for a shipped language until its words arrive, then them", async () => {
    expect(localeLoaded("ru")).toBe(false);
    expect(say("ru", "common.cancel")).toBe("Cancel");
    await loadLocale("ru");
    expect(localeLoaded("ru")).toBe(true);
    expect(say("ru", "common.cancel")).not.toBe("Cancel");
    // The two complete languages are always here.
    expect(localeLoaded("en") && localeLoaded("zh")).toBe(true);
  });

  it("shows English for a language with no words at all", () => {
    expect(say("ko", "common.cancel")).toBe("Cancel");
  });

  it("translates English that is strings by namespace and key, as a pack file is", () => {
    for (const [ns, entries] of Object.entries(en)) for (const [key, text] of Object.entries(entries)) expect(typeof text, `${ns}.${key}`).toBe("string");
  });
});
