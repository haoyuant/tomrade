/**
 * Automatic placement for an architecture sent without coordinates (or one whose own placement
 * kept failing): coordinates are dropped and every candidate places every component without overlap.
 */
import { describe, expect, it } from "vitest";
import { arrangements, semantic, unplaced } from "../src/layout.js";
import { briefDiagnostics } from "../src/runtime.js";

const spec = () => ({
  schema_version: 1,
  diagram_type: "architecture",
  viewBox: [1200, 880],
  meta: { title: "Memer v1", locale: "zh-CN", quality_profile: "showcase", viewBox: [1200, 880] },
  components: [
    { id: "app", type: "frontend", label: "移动 App", sublabel: "iOS / Android", pos: [40, 300], size: [140, 64] },
    { id: "gw", type: "backend", label: "API 网关", pos: [230, 300], size: [150, 62] },
    { id: "gen", type: "backend", label: "生成服务", row: 1, col: 2 },
    { id: "queue", type: "messagebus", label: "生成任务队列" },
    { id: "worker", type: "backend", label: "生成 Worker" },
    { id: "db", type: "database", label: "主数据库" }
  ],
  boundaries: [{ kind: "region", label: "服务端", wraps: ["gw", "gen", "queue", "worker"] }],
  connections: [
    { id: "a", from: "app", to: "gw", label: "HTTPS / JSON", fromSide: "right", via: [[200, 300]] },
    { id: "b", from: "gw", to: "gen", label: "创建任务", labelAt: [300, 200] },
    { id: "c", from: "gen", to: "queue", label: "入队" },
    { id: "d", from: "queue", to: "worker" },
    { id: "e", from: "worker", to: "db", label: "写结果" },
    { id: "f", from: "gw", to: "db" }
  ]
});

type Box = { id: string; pos: [number, number]; size: [number, number] };
const boxes = (s: Record<string, unknown>) => s.components as Box[];
const overlap = (a: Box, b: Box) =>
  a.pos[0] < b.pos[0] + b.size[0] && b.pos[0] < a.pos[0] + a.size[0] && a.pos[1] < b.pos[1] + b.size[1] && b.pos[1] < a.pos[1] + a.size[1];

describe("architecture placement", () => {
  it("keeps what the diagram means and drops every coordinate and route control", () => {
    const out = semantic(spec()) as ReturnType<typeof spec>;
    expect(out.viewBox).toBeUndefined();
    expect(out.meta).toEqual({ title: "Memer v1", locale: "zh-CN", quality_profile: "showcase" });
    for (const c of out.components) expect(Object.keys(c).sort()).toEqual(Object.keys(c).filter((k) => !["pos", "size", "row", "col"].includes(k)).sort());
    expect(out.components.map((c) => c.label)).toEqual(spec().components.map((c) => c.label));
    expect(out.connections[0]).toEqual({ id: "a", from: "app", to: "gw", label: "HTTPS / JSON" });
    expect(out.connections[1]).toEqual({ id: "b", from: "gw", to: "gen", label: "创建任务" });
    expect(out.boundaries).toEqual(spec().boundaries);
  });

  it("leaves the layout to the renderer only when the author placed nothing", () => {
    expect(unplaced(spec())).toBe(false);
    expect(unplaced(semantic(spec()))).toBe(true);
    expect(unplaced({ components: [{ id: "a" }, { id: "b", row: 0, col: 1 }] })).toBe(false);
    expect(unplaced({ layout: { mode: "grid" }, components: [{ id: "a" }] })).toBe(false);
    expect(unplaced({ components: [] })).toBe(false);
  });

  it("places every component of every candidate, apart, inside the canvas", () => {
    const candidates = arrangements(spec());
    expect(candidates.length).toBeGreaterThan(4);
    for (const candidate of candidates) {
      const list = boxes(candidate);
      expect(list).toHaveLength(6);
      const [width, height] = (candidate.meta as { viewBox: [number, number] }).viewBox;
      for (const [i, a] of list.entries()) {
        expect(a.pos[0]).toBeGreaterThanOrEqual(0);
        expect(a.pos[0] + a.size[0]).toBeLessThanOrEqual(width);
        expect(a.pos[1] + a.size[1]).toBeLessThanOrEqual(height);
        for (const b of list.slice(i + 1)) expect(overlap(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      }
      expect((candidate.meta as { quality_profile: string }).quality_profile).toBe("showcase");
    }
  });

  it("names facing sides when ranks stack, since Archify would pick left/right on its own", () => {
    const stacked = arrangements(spec()).filter((c) => (c.connections as { fromSide?: string }[]).some((e) => e.fromSide === "bottom"));
    expect(stacked.length).toBeGreaterThan(0);
    for (const candidate of stacked)
      for (const e of candidate.connections as { fromSide?: string; toSide?: string }[])
        expect([`${e.fromSide}/${e.toSide}`]).toContain({ bottom: "bottom/top", top: "top/bottom", right: "right/left", left: "left/right" }[e.fromSide!]);
  });

  it("gives the same candidates for the same spec", () => {
    expect(arrangements(spec())).toEqual(arrangements(spec()));
  });
});

describe("brief diagnostics", () => {
  it("fits a dense diagram's failures into what the model reads", () => {
    const diagnostics = Array.from({ length: 57 }, (_, i) => ({
      code: i % 3 ? "composition/proper-crossing" : "clean-flow/edge-through-node",
      severity: "error",
      message: `[code] connections[${i}] crosses something\n  label rect: [1, 2, 3, 4]\n  ${"detail ".repeat(80)}`,
      subject: { id: `edge-${i}` },
      evidence: { big: "x".repeat(2000) },
      supportedFixes: ["move the component"]
    }));
    const brief = briefDiagnostics({ ok: false, input: "/private/tmp/somewhere.json", diagnostics }) as { errors: number; counts: Record<string, number>; first: unknown[]; more?: string };
    expect(brief.errors).toBe(57);
    expect(brief.counts).toEqual({ "clean-flow/edge-through-node": 19, "composition/proper-crossing": 38 });
    expect(brief.first).toHaveLength(8);
    expect(brief.more).toContain("49 more");
    expect(JSON.stringify(brief).length).toBeLessThan(6000);
    expect(JSON.stringify(brief)).not.toContain("/private/tmp");
  });

  it("passes a plain failure message through, shortened", () => {
    expect(briefDiagnostics("x".repeat(5000))).toHaveLength(2000);
  });
});
