import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog, Hub } from "@tomrade/hub";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hub-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const files = (name: string) => ({
  stateFile: path.join(dir, name, "hub.json"),
  catalogFile: path.join(dir, name, "catalog.json"),
  deviceFile: path.join(dir, name, "device.json"),
  defaultDir: path.join(dir, name, "Tomrade")
});

describe("the catalog", () => {
  it("round-trips projects and repos through an atomic file, sorted by creation", () => {
    const file = path.join(dir, "catalog.json");
    const a = new Catalog(file);
    a.upsertProject({ id: "p2", name: "Later", createdAt: 2 });
    a.upsertProject({ id: "p1", name: "Earlier", createdAt: 1, git: "dedicated", remote: { provider: "github", config: { owner: "acme", repo: "app" } } });
    a.setRepo("git@github.com:acme/app.git", { checkout: "/code/app" });
    const b = new Catalog(file);
    expect(b.projects().map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(b.project("p1")?.remote).toEqual({ provider: "github", config: { owner: "acme", repo: "app" } });
    expect(b.project("p2")?.git).toBe("none");
    expect(b.repo("git@github.com:acme/app.git")?.checkout).toBe("/code/app");
    b.patchProject("p2", { archived: true, lastLoggedSeq: 12 });
    b.removeProject("p1");
    const c = new Catalog(file);
    expect(c.projects().map((p) => [p.id, p.archived, p.lastLoggedSeq])).toEqual([["p2", true, 12]]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("treats a file it cannot parse as empty rather than guessing", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(new Catalog(file).projects()).toEqual([]);
  });
});

describe("the hub", () => {
  it("keeps one device id per machine across restarts", async () => {
    const config = files("device");
    const first = new Context();
    await first.plugin(Hub, config);
    const id = first.hub.deviceId;
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    await first.fiber.dispose();
    const second = new Context();
    await second.plugin(Hub, config);
    expect(second.hub.deviceId).toBe(id);
  });

  it("is unconfigured until a folder is chosen, then remembers it", async () => {
    const config = files("configure");
    const ctx = new Context();
    await ctx.plugin(Hub, config);
    expect(ctx.hub.configured).toBe(false);
    expect(ctx.hub.dir).toBeNull();
    expect(ctx.hub.info().defaultDir).toBe(config.defaultDir);
    const chosen = path.join(dir, "configure", "MyTomrade");
    ctx.hub.configure(chosen);
    expect(fs.existsSync(chosen)).toBe(true);
    await ctx.fiber.dispose();
    const again = new Context();
    await again.plugin(Hub, config);
    expect(again.hub.dir).toBe(chosen);
    expect(again.hub.configured).toBe(true);
  });

  it("in memory mode is configured at the default dir and writes nothing", async () => {
    const ctx = new Context();
    await ctx.plugin(Hub, { memory: true, defaultDir: "/nowhere" });
    expect(ctx.hub.dir).toBe("/nowhere");
    expect(ctx.hub.deviceId).toBe("test-device");
    ctx.hub.catalog.upsertProject({ id: "x", name: "X" });
    expect(ctx.hub.catalog.project("x")?.name).toBe("X");
  });
});
