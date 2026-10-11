import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { semantic } from "../src/layout.js";
import { ArchifyRuntime, diagramTypes } from "../src/runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tomrade-archify-test-"));
  temporary.push(dir);
  return dir;
}

describe("Archify runtime", () => {
  it("rejects unknown diagram types before installing or reading a path", async () => {
    const runtime = new ArchifyRuntime(await directory());
    const install = vi.spyOn(runtime, "ensureInstalled");
    // Exercise untyped callers at the runtime boundary.
    await expect(runtime.schema("../../secret" as never)).rejects.toThrow("Unknown diagram type");
    expect(install).not.toHaveBeenCalled();
  });
});

// Opt-in integration exercises the actual upstream renderer, without network in unit tests.
describe.runIf(!!process.env.ARCHIFY_TEST_SKILL)("upstream Archify integration", () => {
  for (const type of diagramTypes) it(`delivers validated ${type} HTML with a receipt`, async () => {
    const runtime = new ArchifyRuntime(await directory());
    vi.spyOn(runtime, "ensureInstalled").mockResolvedValue(process.env.ARCHIFY_TEST_SKILL!);
    const { example } = await runtime.schema(type);
    const result = await runtime.render(type, example, await directory());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (result.ok) {
      expect(await fs.readFile(result.artifact, "utf8")).toContain("<svg");
      expect(result.receipt).toBeTruthy();
      expect(JSON.parse(await fs.readFile(result.source, "utf8"))).toEqual(example);
    }
  });

  it("lays out an architecture sent without coordinates", async () => {
    const runtime = new ArchifyRuntime(await directory());
    vi.spyOn(runtime, "ensureInstalled").mockResolvedValue(process.env.ARCHIFY_TEST_SKILL!);
    const { example } = await runtime.schema("architecture");
    const result = await runtime.render("architecture", semantic(example), await directory());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, layout: "automatic" });
    if (result.ok) expect((JSON.parse(await fs.readFile(result.source, "utf8")) as { components: { pos?: unknown }[] }).components.every((c) => Array.isArray(c.pos))).toBe(true);
  });

  it("renders a placed architecture exactly as written, failures and all", async () => {
    const runtime = new ArchifyRuntime(await directory());
    vi.spyOn(runtime, "ensureInstalled").mockResolvedValue(process.env.ARCHIFY_TEST_SKILL!);
    const { example } = await runtime.schema("architecture");
    const passing = await runtime.render("architecture", example, await directory());
    expect(Object.keys(passing).sort()).toEqual(["artifact", "ok", "receipt", "revision", "source"]);
    // Every component on one spot: a placement Archify rejects, reported in full for the author to repair.
    const crowded = { ...example, components: (example.components as Record<string, unknown>[]).map((c) => ({ ...c, pos: [40, 40] })) };
    const failing = await runtime.render("architecture", crowded, await directory());
    expect(failing.ok).toBe(false);
    if (!failing.ok) expect(failing.diagnostics).toMatchObject({ ok: false, command: "deliver" });
    const arranged = await runtime.render("architecture", crowded, await directory(), undefined, { arrange: true });
    expect(arranged, JSON.stringify(arranged)).toMatchObject({ ok: true, layout: "automatic" });
  });

  it("returns diagnostics and no artifact for invalid input", async () => {
    const runtime = new ArchifyRuntime(await directory());
    vi.spyOn(runtime, "ensureInstalled").mockResolvedValue(process.env.ARCHIFY_TEST_SKILL!);
    const dir = await directory();
    const result = await runtime.render("architecture", {}, dir);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.diagnostics).toBeTruthy();
    await expect(fs.access(path.join(dir, "diagram.html"))).rejects.toThrow();
  });
});
