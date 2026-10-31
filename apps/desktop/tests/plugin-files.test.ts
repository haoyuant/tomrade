import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));
import { pluginFileFor } from "../src/plugin-files.js";

it("asks the contributions service for a plugin's file by publisher, name and path, and answers nothing for any other URL", () => {
  const asked: [string, string][] = [];
  const ctx = { get: (name: string) => (name === "contributions" ? { layoutRoot: (pluginId: string) => (pluginId === "someone/demo" ? `/plugins/${pluginId}` : null), layoutFile: (pluginId: string, file: string) => (asked.push([pluginId, file]), `/plugins/${pluginId}/${file}`) } : undefined) };
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/demo/dist/layout.js?rev=3")).toBe("/plugins/someone/demo/dist/layout.js");
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/demo/assets/a%20b.css")).toBe("/plugins/someone/demo/assets/a b.css");
  expect(asked).toEqual([["someone/demo", "dist/layout.js"], ["someone/demo", "assets/a b.css"]]);
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/")).toBeNull();
  expect(pluginFileFor(ctx, "https://someone/demo/dist/layout.js")).toBeNull();
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/other/dist/layout.js")).toBeNull();
  expect(pluginFileFor({ get: () => undefined }, "tomrade-plugin://someone/demo/dist/layout.js")).toBeNull();
});

it("serves the frame's page from the app's build under a layout plugin's origin, and nothing else under that name", () => {
  const ctx = { get: () => ({ layoutRoot: (pluginId: string) => (pluginId === "someone/demo" ? "/plugins/someone/demo" : null), layoutFile: () => "/never" }) };
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/demo/__tomrade__/plugin-layout-shell.html", "/app/ui/plugin-layout-shell.html")).toBe("/app/ui/plugin-layout-shell.html");
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/demo/__tomrade__/other.html", "/app/ui/plugin-layout-shell.html")).toBeNull();
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/demo/__tomrade__/plugin-layout-shell.html")).toBeNull();
  expect(pluginFileFor(ctx, "tomrade-plugin://someone/other/__tomrade__/plugin-layout-shell.html", "/app/ui/plugin-layout-shell.html")).toBeNull();
});
