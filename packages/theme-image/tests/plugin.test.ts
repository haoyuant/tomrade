import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Context, Service } from "cordis";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import * as themeImage from "@tomradex/theme-image";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-theme-image-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture")]).toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("picture")]).toString("base64");

class FakeIpc extends Service {
  static provide = "ipc";
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, handler: (...args: never[]) => unknown) {
    return this.ctx.effect(() => {
      this.handlers.set(channel, handler as (...args: unknown[]) => unknown);
      return () => this.handlers.delete(channel);
    });
  }
  send() {}
  call(channel: string, ...args: unknown[]) {
    return this.handlers.get(channel)!(...args);
  }
}

/** The assistant as the plugin sees it: whether its engine sees pictures, and the conversations it opens. */
class FakeAgent extends Service {
  static provide = "agent";
  sees = true;
  threads: { projectId: string; engine?: string; title?: string; id: string }[] = [];
  sent: { threadId: string; text: string; attachments: { name: string; mime: string }[] }[] = [];
  answering(id: string) { return id; }
  settingsOf() { return { defaultEngine: "tomrade", engines: {} }; }
  engineOf() { return { available: async () => ({ ok: true }) }; }
  mediaFor() { return { input: this.sees ? ["image/png", "image/jpeg"] : [], output: [] }; }
  newThread(projectId: string, engine: string, _board: null, opts: { title?: string }) { const thread = { id: `t${this.threads.length + 1}`, projectId, engine, title: opts.title }; this.threads.push(thread); return thread; }
  uploadMedia(_projectId: string, _threadId: string, upload: { name: string; mime: string }) { return { id: "m1", name: upload.name, mime: upload.mime, size: 1 }; }
  send(_projectId: string, threadId: string, input: { text: string; attachments: { name: string; mime: string }[] }) { this.sent.push({ threadId, text: input.text, attachments: input.attachments }); return { runId: "r1" }; }
}

async function boot(name: string) {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(dir, `${name}-settings.json`) });
  await ctx.plugin(FakeIpc);
  await ctx.plugin(Tools);
  await ctx.plugin(FakeAgent);
  const images = path.join(dir, `${name}-images`);
  await ctx.plugin(themeImage, { dir: images });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { ctx, images, ipc: ctx.get("ipc") as unknown as FakeIpc, agent: ctx.get("agent") as unknown as FakeAgent };
}

describe("theme-image", () => {
  it("keeps one picture per theme, typed by its bytes", async () => {
    const { ipc, images } = await boot("keep");
    expect(ipc.call("themeImage.read", "custom:abc")).toBeNull();
    expect(ipc.call("themeImage.save", "custom:abc", { base64: PNG })).toEqual({ mime: "image/png", bytes: Buffer.from(PNG, "base64").length });
    expect(ipc.call("themeImage.read", "custom:abc")).toEqual({ mime: "image/png", base64: PNG });
    ipc.call("themeImage.save", "custom:abc", { base64: JPEG });
    expect(fs.readdirSync(images)).toEqual(["abc.jpg"]);
    expect(ipc.call("themeImage.read", "custom:abc")).toEqual({ mime: "image/jpeg", base64: JPEG });
  });

  it("keeps the Terminal window's picture beside the main one, and lets it go alone", async () => {
    const { ipc, images } = await boot("slots");
    ipc.call("themeImage.save", "custom:abc", { base64: PNG });
    expect(ipc.call("themeImage.read", "custom:abc", "terminal")).toBeNull();
    ipc.call("themeImage.save", "custom:abc", { base64: JPEG }, "terminal");
    expect(fs.readdirSync(images).sort()).toEqual(["abc.png", "abc.terminal.jpg"]);
    expect(ipc.call("themeImage.read", "custom:abc")).toEqual({ mime: "image/png", base64: PNG });
    expect(ipc.call("themeImage.read", "custom:abc", "terminal")).toEqual({ mime: "image/jpeg", base64: JPEG });
    ipc.call("themeImage.remove", "custom:abc", "terminal");
    expect(fs.readdirSync(images)).toEqual(["abc.png"]);
    expect(() => ipc.call("themeImage.read", "custom:abc", "../x")).toThrow(/slot/);
  });

  it("refuses what is not a picture, and ids that are not a custom theme's", async () => {
    const { ipc } = await boot("refuse");
    expect(() => ipc.call("themeImage.save", "custom:abc", { base64: Buffer.from("<svg/>").toString("base64") })).toThrow(/PNG, JPEG or WebP/);
    expect(() => ipc.call("themeImage.save", "../escape", { base64: PNG })).toThrow(/custom theme id/);
    expect(() => ipc.call("themeImage.read", "custom:../x")).toThrow(/custom theme id/);
  });

  const palette = { swatches: [{ rgb: [250, 228, 236] as const, share: 0.7 }, { rgb: [214, 52, 110] as const, share: 0.3 }], lightness: 0.85 };
  const pictures = { main: { base64: PNG }, palette, frost: 6, fonts: { "text-sm": "13px" }, fallbackName: "Ribbon" };
  const worn = (ctx: Context) => {
    const settings = (ctx.get("settings") as Settings).get();
    return { theme: settings.theme, themes: settings.customThemes as { id: string; name: string; base: string; backdrop: { veil: number; frost: number; terminalVeil?: number }; fonts: Record<string, string> }[] };
  };

  it("makes and wears a theme from the picture's own colours at once", async () => {
    const { ctx, ipc, images } = await boot("local");
    expect(ipc.call("themeImage.local", { ...pictures, terminal: { base64: JPEG }, terminalPalette: palette })).toEqual({ name: "Ribbon" });
    const { theme, themes } = worn(ctx);
    expect(themes).toHaveLength(1);
    expect(theme).toBe(themes[0]!.id);
    expect(themes[0]).toMatchObject({ name: "Ribbon", base: "light", backdrop: { frost: 6 }, fonts: { "text-sm": "13px" } });
    expect(themes[0]!.backdrop.terminalVeil).toBeGreaterThanOrEqual(0.5);
    const id = themes[0]!.id.slice("custom:".length);
    expect(fs.readdirSync(images).sort()).toEqual([`${id}.png`, `${id}.terminal.jpg`]);
  });

  it("opens a conversation with the picture on the assistant's engine, and its tool makes, then revises, the theme", async () => {
    const { ctx, ipc, agent } = await boot("start");
    const opened: unknown[] = [];
    ctx.on("desktop/open", (target) => void opened.push(target));
    const started = await ipc.call("themeImage.start", { ...pictures, projectId: "p1", view: { mime: "image/jpeg", base64: JPEG } });
    expect(started).toEqual({ projectId: "p1", threadId: "t1" });
    expect(agent.threads[0]).toMatchObject({ projectId: "p1", engine: "tomrade", title: "Theme from Ribbon" });
    expect(agent.sent[0]).toMatchObject({ threadId: "t1", attachments: [{ mime: "image/jpeg" }] });
    expect(agent.sent[0]!.text).toContain("theme_from_picture");
    expect(opened).toEqual([{ projectId: "p1", threadId: "t1" }]);
    expect(worn(ctx).themes).toEqual([]);

    const tools = ctx.get("tools") as Tools;
    const seed = { mode: "dark", canvas: "#1a1530", accent: "#d6346e", tag: "#3a6ea5", font: "mincho", name: "Night Ribbon" };
    const by = { kind: "agent", id: "tomrade" } as never;
    await tools.execute("theme_from_picture", seed, { by, run: { threadId: "t1", projectId: "p1" } as never });
    let { theme, themes } = worn(ctx);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ name: "Night Ribbon", base: "dark", backdrop: { frost: 6 } });
    expect(themes[0]!.fonts["font-display"]).toContain("Mincho");
    expect(theme).toBe(themes[0]!.id);
    await tools.execute("theme_from_picture", { ...seed, mode: "light", name: "Noon Ribbon" }, { by, run: { threadId: "t1", projectId: "p1" } as never });
    ({ themes } = worn(ctx));
    expect(themes.map(t => [t.name, t.base])).toEqual([["Noon Ribbon", "light"]]);
    await expect(tools.execute("theme_from_picture", seed, { by, run: { threadId: "elsewhere", projectId: "p1" } as never })).rejects.toThrow(/no picture waits here/);
  });

  it("starts nothing when the assistant cannot see pictures", async () => {
    const { ipc, agent } = await boot("blind");
    agent.sees = false;
    await expect(ipc.call("themeImage.start", { ...pictures, projectId: "p1", view: { mime: "image/jpeg", base64: JPEG } })).resolves.toBeNull();
    expect(agent.threads).toEqual([]);
  });

  it("lets a deleted theme's picture go once the theme has stayed gone", async () => {
    const { ctx, ipc, images } = await boot("prune");
    vi.useFakeTimers();
    try {
      const theme = (id: string) => ({ id, name: id, base: "light", icon: "i-sliders", tokens: Object.fromEntries(["bg", "surface", "surface-warm", "fg", "fg-2", "muted", "meta", "border", "border-soft", "accent", "accent-on", "accent-light", "accent-active", "success", "warn", "danger", "tag-bg-faint", "tag-bg-soft", "tag-bg-base", "tag-bg-strong", "tag-fg"].map(k => [k, "#808080"])), fonts: {} });
      const settings = ctx.get("settings") as Settings;
      settings.set({ ...settings.get(), customThemes: [theme("custom:kept"), theme("custom:gone"), theme("custom:undone")] });
      for (const id of ["kept", "gone", "undone"]) ipc.call("themeImage.save", `custom:${id}`, { base64: PNG });
      ipc.call("themeImage.save", "custom:gone", { base64: PNG }, "terminal");
      settings.set({ ...settings.get(), customThemes: [theme("custom:kept")] });
      settings.set({ ...settings.get(), customThemes: [theme("custom:kept"), theme("custom:undone")] });
      expect(fs.readdirSync(images).sort()).toEqual(["gone.png", "gone.terminal.png", "kept.png", "undone.png"]);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(fs.readdirSync(images).sort()).toEqual(["kept.png", "undone.png"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
