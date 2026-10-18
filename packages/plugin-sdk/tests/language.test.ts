import { describe, expect, it } from "vitest";
import { parseLanguagePack, parseManifest } from "@tomradex/plugin-sdk";

const base = { id: "someone/portugues", version: "1.0.0", title: "Português", license: "MIT", engines: { sdk: "^0.2.8" } };
const pt = { tag: "pt-BR", name: "Português (Brasil)", file: "languages/pt-BR.json" };

describe("a language pack in the manifest", () => {
  it("takes a plugin with no code that adds languages", () => {
    const manifest = parseManifest({ ...base, main: null, languages: [pt, { tag: "ko", name: "한국어", file: "languages/ko.json" }] });
    expect(manifest.main).toBeNull();
    expect(manifest.languages.map((l) => l.tag)).toEqual(["pt-BR", "ko"]);
  });

  it("keeps code and languages side by side, and a plugin without either field as it was", () => {
    expect(parseManifest({ ...base, languages: [pt] }).main).toBe("dist/index.js");
    expect(parseManifest(base)).toMatchObject({ main: "dist/index.js", languages: [] });
  });

  it("refuses what cannot be a pack", () => {
    expect(() => parseManifest({ ...base, main: null })).toThrow(/no code; it must add a language/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, tag: "en" }] })).toThrow(/English is what every pack translates/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, tag: "pt-br" }] })).toThrow(/canonical BCP 47/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, tag: "system" }] })).toThrow(/canonical BCP 47/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, file: "../elsewhere/pt.json" }] })).toThrow(/inside the plugin/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, file: "/etc/pt.json" }] })).toThrow(/relative path/);
    expect(() => parseManifest({ ...base, main: null, languages: [{ ...pt, file: "languages/pt.js" }] })).toThrow(/\.json/);
    expect(() => parseManifest({ ...base, main: null, languages: [pt, { ...pt, file: "languages/again.json" }] })).toThrow(/"pt-BR" is listed twice/);
  });
});

describe("a language pack file", () => {
  it("is the interface's and the backend's words, by namespace and key", () => {
    const pack = parseLanguagePack(pt, JSON.stringify({ ui: { common: { cancel: "Cancelar" } }, backend: { doctor: { stopped: "Parado." } } }));
    expect(pack).toEqual({ tag: "pt-BR", name: "Português (Brasil)", ui: { common: { cancel: "Cancelar" } }, backend: { doctor: { stopped: "Parado." } } });
    expect(parseLanguagePack(pt, "{}")).toMatchObject({ ui: {}, backend: {} });
  });

  it("holds strings and nothing else", () => {
    expect(() => parseLanguagePack(pt, "{ nope")).toThrow(/languages\/pt-BR\.json is not JSON/);
    expect(() => parseLanguagePack(pt, JSON.stringify({ ui: { common: { cancel: 3 } } }))).toThrow(/ui\.common\.cancel/);
    expect(() => parseLanguagePack(pt, JSON.stringify({ ui: { common: { cancel: { html: "<b>x</b>" } } } }))).toThrow(/ui\.common\.cancel/);
    expect(() => parseLanguagePack(pt, JSON.stringify({ prompts: { system: "Responda em português" } }))).toThrow(/\(root\)/);
    expect(() => parseLanguagePack(pt, JSON.stringify({ ui: { common: { cancel: "x".repeat(5000) } } }))).toThrow(/ui\.common\.cancel/);
  });
});
