import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { definePlugin } from "@tomradex/plugin-sdk";
import { testPlugin, type HostTestInput } from "@tomradex/plugin-host";

const run = (plugin: unknown, scenario?: (t: never) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-"));
  fs.writeFileSync(path.join(dir, "panel.html"), "<!doctype html>");
  return testPlugin({ plugin: plugin as HostTestInput["plugin"], id: "local/demo", namespace: "demo", dir, tmp: dir, scenario: scenario ? async () => ({ default: scenario }) : null });
};

it("names the services a plugin waits for that the sandbox does not provide", async () => {
  const result = await run(definePlugin({ inject: ["tools", "agent"], async apply() {} }));
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual([{ name: "loads", ok: false, detail: "waits for agent, which this sandbox does not provide; move it to optional to load without it" }]);
});

it("gives a plugin with a window a sandbox window, which the scenario can read and speak for", async () => {
  let closes = 0;
  const plugin = definePlugin({
    inject: ["contributions", "surfaces"],
    async apply(ctx) {
      await ctx.contributions.command({
        id: "demo.open",
        title: "Open",
        run: async () => {
          const panel = await ctx.surfaces.open({ id: "demo.panel", title: "Panel", document: "panel.html", width: 300, height: 200, onMessage: async (m) => void (await panel.setState({ echo: m })), onClose: () => void closes++ });
          await panel.setState({ ready: true });
        }
      });
    }
  });
  const result = await run(plugin, async (t: never) => {
    const s = t as { command(id: string): Promise<unknown>; surfaces: { opened(): { id: string; state: unknown; closed: boolean }[]; message(id: string, m: unknown): Promise<void>; close(id: string): Promise<void> }; check(n: string, ok: boolean, d?: string): void };
    await s.command("demo.open");
    s.check("opened", s.surfaces.opened()[0]?.id === "demo.panel" && JSON.stringify(s.surfaces.opened()[0]!.state) === '{"ready":true}', JSON.stringify(s.surfaces.opened()));
    await s.surfaces.message("demo.panel", "hi");
    s.check("echoed", JSON.stringify(s.surfaces.opened()[0]!.state) === '{"echo":"hi"}', JSON.stringify(s.surfaces.opened()));
    await s.surfaces.close("demo.panel");
    s.check("closed", s.surfaces.opened()[0]!.closed && closes === 1, String(closes));
  });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["loads", "opened", "echoed", "closed"]));
});

it("opens a working window in the sandbox for a plugin whose manifest grants it, and records what it posts", async () => {
  const plugin = definePlugin({
    inject: ["contributions", "surfaces"],
    async apply(ctx) {
      await ctx.contributions.command({
        id: "demo.open",
        title: "Open",
        run: async () => {
          const win = await ctx.surfaces.open({ id: "demo.win", title: "Sessions", document: "panel.html", width: 900, height: 600, kind: "window", minWidth: 400 });
          await win.post({ frame: 1 });
        }
      });
    }
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-"));
  fs.writeFileSync(path.join(dir, "panel.html"), "<!doctype html>");
  const result = await testPlugin({ plugin: plugin as HostTestInput["plugin"], id: "local/demo", namespace: "demo", title: "Demo", window: true, dir, tmp: dir, scenario: async () => ({
    default: async (t: never) => {
      const s = t as { command(id: string): Promise<unknown>; surfaces: { opened(): { id: string; title: string; kind: string; posted: unknown[] }[] }; check(n: string, ok: boolean, d?: string): void };
      await s.command("demo.open");
      const [win] = s.surfaces.opened();
      s.check("a window", win?.kind === "window" && win.title === "Sessions — Demo", JSON.stringify(win));
      s.check("posted", JSON.stringify(win?.posted) === '[{"frame":1}]', JSON.stringify(win?.posted));
    }
  }) });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["a window", "posted"]));
});

it("gives a web search provider the app's web search module, so the scenario can search through it", async () => {
  const plugin = definePlugin({
    inject: ["webSearch"],
    async apply(ctx) {
      await ctx.webSearch.register({ id: "demo", title: "Demo", unavailable: () => null, search: (r) => ({ results: [{ title: r.query, url: "https://example.com/", content: "hit" }] }) });
    }
  });
  const result = await run(plugin, async (t: never) => {
    const s = t as { tool(name: string, args: unknown): Promise<unknown>; check(n: string, ok: boolean, d?: string): void };
    const text = await s.tool("web_search", { query: "tomrade" });
    s.check("searches through the provider", text === "1. tomrade\nhttps://example.com/\nhit", String(text));
  });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["loads", "searches through the provider"]));
});

it("puts a policy plugin's write gate and tool gate in front of the sandbox's writes and tool calls", async () => {
  const plugin = definePlugin({
    inject: ["items", "tools"],
    async apply(ctx) {
      await ctx.items.gate((write) => {
        if ((write.patch as { title?: string } | null)?.title === "") throw new Error("demo: a title cannot be empty");
      });
      await ctx.tools.gate((call) => (call.name === "count_items" ? { result: 42 } : undefined));
    }
  });
  const result = await run(plugin, async (t: never) => {
    const s = t as { createItem(title: string): { id: string }; updateItem(id: string, patch: Record<string, unknown>): unknown; tool(name: string, args?: unknown): Promise<unknown>; check(n: string, ok: boolean, d?: string): void };
    const item = s.createItem("Named");
    let refused = "";
    try {
      s.updateItem(item.id, { title: "" });
    } catch (error) {
      refused = (error as Error).message;
    }
    s.check("write refused", refused.includes("cannot be empty"), refused);
    s.check("tool answered by the gate", (await s.tool("count_items")) === 42);
  });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["write refused", "tool answered by the gate"]));
});
