import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWords } from "@tomradex/domain";
import { resolveLocale, Settings, type InstalledLanguage, type SettingsSectionView } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-settings-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `settings-${n++}.json`);

describe("settings", () => {
  it("returns defaults for registered sections and persists what is set", async () => {
    const p = file();
    const { ctx } = await fresh({ plugins: [[Settings, { path: p }]] });
    expect(ctx.settings.get().theme).toBe("sunrise");
    expect(ctx.settings.get().language).toBe("system");
    expect(ctx.settings.get().themeAutomation.defaultTheme).toBe("sunrise");
    const changes: string[] = [];
    ctx.on("settings/changed", (next, previous) => changes.push(`${previous.theme}->${next.theme}`));
    ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
    expect(changes).toEqual(["sunrise->dark"]);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).theme).toBe("dark");

    const reopened = await fresh({ plugins: [[Settings, { path: p }]] });
    expect(reopened.ctx.settings.get().theme).toBe("dark");
  });

  it("persists Dawn as a selected theme and in automatic schedules", async () => {
    const p = file();
    const { ctx } = await fresh({ plugins: [[Settings, { path: p }]] });
    ctx.settings.set({ ...ctx.settings.get(), theme: "dawn", themeAutomation: {
      mode: "schedule", defaultTheme: "dawn", shuffleMinutes: 60,
      schedule: [{ start: "08:00", end: "18:00", theme: "dawn" }]
    } });
    const reopened = await fresh({ plugins: [[Settings, { path: p }]] });
    expect(reopened.ctx.settings.get().theme).toBe("dawn");
    expect(reopened.ctx.settings.get().themeAutomation).toMatchObject({
      defaultTheme: "dawn", schedule: [{ theme: "dawn" }]
    });
  });

  it("a retired theme a saved setting still names saves as the one closest to it", async () => {
    const p = file();
    fs.writeFileSync(p, JSON.stringify({ theme: "neon" }));
    const { ctx } = await fresh({ plugins: [[Settings, { path: p }]] });
    ctx.settings.set({ ...ctx.settings.get(), themeAutomation: {
      mode: "schedule", defaultTheme: "neon", shuffleMinutes: 60, schedule: [{ start: "20:00", end: "06:00", theme: "neon" }]
    } });
    expect(ctx.settings.get().theme).toBe("dark");
    expect(ctx.settings.get().themeAutomation).toMatchObject({ defaultTheme: "dark", schedule: [{ theme: "dark" }] });
  });

  it("a plugin section gets defaults under stored values, validation, and a JSON-schema card", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    const fiber = await ctx.plugin({
      name: "demo",
      inject: ["settings"],
      apply(ctx) {
        ctx.settings.register({ id: "demo", title: "Demo", schema: z.object({ days: z.number().int().min(1), label: z.string().meta({ advanced: true }) }), defaults: { days: 14, label: "stale" } });
      }
    });
    expect(ctx.settings.get().demo).toEqual({ days: 14, label: "stale" });
    ctx.settings.set({ ...ctx.settings.get(), demo: { days: 3, label: "stale" } });
    expect(ctx.settings.get().demo).toEqual({ days: 3, label: "stale" });
    expect(() => ctx.settings.set({ ...ctx.settings.get(), demo: { days: 0, label: "stale" } })).toThrow();

    const card = ctx.settings.sections().find((s) => s.id === "demo") as SettingsSectionView;
    expect(card.title).toBe("Demo");
    expect((card.schema.properties as Record<string, unknown>).days).toMatchObject({ type: "integer" });
    // a field's meta rides along, which is how a plugin folds a knob under Advanced
    expect((card.schema.properties as Record<string, unknown>).label).toMatchObject({ type: "string", advanced: true });

    await fiber.dispose();
    // closedWindow is the items service's, which fresh() boots
    expect(ctx.settings.sections().map((s) => s.id)).toEqual(["theme", "themeAutomation", "customThemes", "performanceMode", "language", "closedWindow"]);
    expect(ctx.settings.get().demo).toEqual({ days: 3, label: "stale" });
  });

  it("refreshes machine choices and keeps an existing value selectable", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    let available = ["Terminal", "none"];
    await ctx.plugin({
      name: "terminal-choices",
      inject: ["settings"],
      apply(ctx) {
        ctx.settings.register({ id: "terminalChoices", title: "Terminal", schema: z.object({ terminal: z.string() }), defaults: { terminal: "Terminal" }, choices: () => ({ terminal: available }) });
      }
    });
    ctx.settings.set({ ...ctx.settings.get(), terminalChoices: { terminal: "Old Terminal" } });
    const options = () => ((ctx.settings.sections().find((s) => s.id === "terminalChoices")!.schema.properties as Record<string, { enum: string[] }>).terminal.enum);
    expect(options()).toEqual(["Terminal", "none", "Old Terminal"]);
    available = ["Warp", "none"];
    expect(options()).toEqual(["Warp", "none", "Old Terminal"]);
  });

  it("a card speaks the asked-for language, falls back to the declaration, and a refusal names the field", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file(), locale: "zh-CN" }]] });
    await ctx.plugin({
      name: "demo",
      inject: ["settings"],
      apply(ctx) {
        ctx.settings.register({
          id: "demo",
          title: "Demo",
          description: "English description",
          schema: z.object({ size: z.number().int().max(10).meta({ title: "Size" }), mode: z.enum(["ask", "off"]).meta({ title: "Mode" }) }),
          defaults: { size: 1, mode: "ask" },
          words: {
            en: { fields: { mode: { options: { ask: "Ask each time", off: "Off" } } } },
            zh: { title: "演示", fields: { size: { title: "大小" }, mode: { options: { ask: "每次询问" } } } }
          }
        });
      }
    });
    const card = (locale?: "en" | "zh") => ctx.settings.sections(locale).find((s) => s.id === "demo")!;
    const field = (locale: "en" | "zh" | undefined, name: string) => (card(locale).schema.properties as Record<string, Record<string, unknown>>)[name];
    // the system locale decides when the person has not chosen
    expect(card().title).toBe("演示");
    expect(card("zh").description).toBe("English description");
    expect(field("zh", "size").title).toBe("大小");
    expect(field("zh", "mode").enumLabels).toEqual({ ask: "每次询问", off: "Off" });
    expect(card("en").title).toBe("Demo");
    expect(field("en", "size").title).toBe("Size");
    expect(field("en", "mode").enumLabels).toEqual({ ask: "Ask each time", off: "Off" });
    expect(() => ctx.settings.set({ ...ctx.settings.get(), demo: { size: 25, mode: "ask" } })).toThrow(/^demo\.size: Too big/);
  });

  it("user-scope sections follow the Hub folder; secrets and machine sections stay put", async () => {
    const hubDir = path.join(dir, `hub-${n++}`);
    const machineFile = file();
    const { ctx } = await fresh({ hubDir, plugins: [[Settings, { path: machineFile }]] });
    ctx.settings.register({ id: "token", title: "Token", schema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" }, scope: "user" });
    ctx.settings.register({ id: "git", title: "Git", schema: z.object({ binary: z.string() }), defaults: { binary: "git" } });
    const scopes = Object.fromEntries(ctx.settings.sections().map((s) => [s.id, s.scope]));
    expect(scopes).toMatchObject({ theme: "user", language: "user", token: "machine", git: "machine" });

    ctx.settings.set({ ...ctx.settings.get(), theme: "dark", token: { token: "s3cret" }, git: { binary: "/opt/git" } });
    const user = JSON.parse(fs.readFileSync(path.join(hubDir, "settings.json"), "utf8"));
    expect(user.sections.theme.value).toBe("dark");
    expect(typeof user.sections.theme.updatedAt).toBe("number");
    expect(user.sections.token).toBeUndefined();
    expect(user.sections.git).toBeUndefined();
    const machine = JSON.parse(fs.readFileSync(machineFile, "utf8"));
    expect(machine.token.token).toBe("s3cret");

    // Another machine's file arrives: the later stamp wins per section.
    ctx.settings.mergeUser({ v: 1, sections: { theme: { value: "matcha", updatedAt: Date.now() + 1000 }, language: { value: "zh", updatedAt: 1 } } });
    expect(ctx.settings.get().theme).toBe("matcha");
    expect(ctx.settings.get().language).toBe("system");
  });
});

describe("resolveLocale", () => {
  it("keeps the language chosen, and lets system pick among the languages there are", () => {
    expect(resolveLocale("zh", "en-US")).toBe("zh");
    expect(resolveLocale("ja", "zh-CN")).toBe("ja");
    expect(resolveLocale("pt-br", "zh-CN")).toBe("pt-BR");
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
    expect(resolveLocale("system", "zh-Hant-TW")).toBe("zh-Hant");
    expect(resolveLocale("system", "zh-TW")).toBe("zh-Hant");
    expect(resolveLocale(undefined, "fr-FR")).toBe("fr");
    expect(resolveLocale("system", "ru-RU")).toBe("ru");
    expect(resolveLocale("system", "pt-BR")).toBe("en");
    expect(resolveLocale("system", "pt-PT", ["en", "zh", "pt-BR"])).toBe("pt-BR");
    expect(resolveLocale("system", undefined)).toBe("en");
  });
});

describe("language packs", () => {
  const SPEAK = defineWords("settings-test", { en: { hello: "Hello, {{name}}." }, zh: { hello: "你好，{{name}}。" } });
  const pack = (plugin: string, tag = "pt-BR"): InstalledLanguage => ({
    tag,
    name: "Português (Brasil)",
    plugin,
    ui: { common: { cancel: "Cancelar" } },
    backend: { "settings-test": { hello: "Olá, {{name}}." } }
  });

  it("lists a pack's language while its plugin runs, speaks it, and lets system pick it", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file(), locale: "pt-BR" }]] });
    const changes: number[] = [];
    ctx.on("settings/languages", () => changes.push(ctx.settings.languages().length));
    expect(ctx.settings.locale()).toBe("en");

    const fiber = ctx.plugin({ name: "pt-pack", inject: ["settings"], apply: (inner) => void inner.settings.addLanguage(pack("alice/pt")) });
    await fiber;
    expect(ctx.settings.languages()).toEqual([{ tag: "pt-BR", name: "Português (Brasil)", plugin: "alice/pt" }]);
    expect(ctx.settings.languagePack("pt-br")).toEqual({ tag: "pt-BR", name: "Português (Brasil)", ui: { common: { cancel: "Cancelar" } } });
    expect(ctx.settings.locale()).toBe("pt-BR");
    expect(SPEAK(ctx.settings.locale())("hello", { name: "Ana" })).toBe("Olá, Ana.");

    await fiber.dispose();
    expect(ctx.settings.languages()).toEqual([]);
    expect(ctx.settings.languagePack("pt-BR")).toBeNull();
    expect(ctx.settings.locale()).toBe("en");
    expect(SPEAK("pt-BR")("hello", { name: "Ana" })).toBe("Hello, Ana.");
    expect(changes).toEqual([1, 0]);
  });

  it("keeps the first pack for a language and sets a second aside", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    const first = ctx.plugin({ name: "first", inject: ["settings"], apply: (inner) => void inner.settings.addLanguage(pack("alice/pt")) });
    const second = ctx.plugin({ name: "second", inject: ["settings"], apply: (inner) => void inner.settings.addLanguage({ ...pack("bob/pt"), backend: { "settings-test": { hello: "Oi, {{name}}." } } }) });
    await first;
    await second;
    expect(ctx.settings.languages().map((l) => l.plugin)).toEqual(["alice/pt"]);
    expect(SPEAK("pt-BR")("hello", { name: "Ana" })).toBe("Olá, Ana.");
    await second.dispose();
    expect(ctx.settings.languages().map((l) => l.plugin)).toEqual(["alice/pt"]);
    await first.dispose();
  });

  it("reads the locale from the language section alone, and follows it as it changes", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file(), locale: "zh-CN" }]] });
    const get = vi.spyOn(Settings.prototype, "get");
    expect(ctx.settings.locale()).toBe("zh");
    ctx.settings.set({ ...ctx.settings.get(), language: "en" });
    get.mockClear();
    expect(ctx.settings.locale()).toBe("en");
    ctx.settings.set({ ...ctx.settings.get(), language: "system" });
    get.mockClear();
    expect(ctx.settings.locale()).toBe("zh");
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("accepts any language tag as the language setting, and refuses what is not one", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    ctx.settings.set({ ...ctx.settings.get(), language: "pt-BR" });
    expect(ctx.settings.get().language).toBe("pt-BR");
    // The pack is not installed: the language is still the one chosen, and its words read English.
    expect(ctx.settings.locale()).toBe("pt-BR");
    expect(() => ctx.settings.set({ ...ctx.settings.get(), language: "not a language" })).toThrow(/language/);
  });

  it("keeps the interface's English a window sends, for a pack's coverage", async () => {
    const { ctx } = await fresh({ plugins: [[Settings, { path: file() }]] });
    expect(ctx.settings.english().ui).toBeNull();
    expect(ctx.settings.english().backend["settings-test"]).toEqual({ hello: "Hello, {{name}}." });
    ctx.settings.useUiEnglish({ common: { cancel: 3 } });
    expect(ctx.settings.english().ui).toBeNull();
    ctx.settings.useUiEnglish({ common: { cancel: "Cancel" } });
    expect(ctx.settings.english().ui).toEqual({ common: { cancel: "Cancel" } });
  });
});
