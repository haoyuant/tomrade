import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLOSED_WINDOW, type FilterClause } from "@tomradex/domain";
import { Settings } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";
import { CLOSED_WINDOW_SECTION } from "../src/settings.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** Tickets closed a day apart, oldest first, so their status times are known. */
async function seed() {
  const f = await fresh();
  const { items, project, board, boards } = f;
  const other = boards.create({ projectId: project.id, name: "Core" });
  let day = 0;
  const at = () => vi.setSystemTime(T0 + ++day * DAY);
  const make = (title: string, status: "done" | "cancelled" | "todo", boardId = board.id) => {
    at();
    const created = items.create({ projectId: project.id, boardId, title, by: "human" });
    if (status === "todo") return items.update(project.id, created.id, { status }, "human");
    at();
    return items.update(project.id, created.id, { status }, "human");
  };
  const epic = items.create({ projectId: project.id, boardId: board.id, title: "Old epic", kind: "epic", status: "done", by: "human" });
  const done = ["d1", "d2", "d3", "d4"].map((t) => make(t, "done"));
  const cancelled = ["c1", "c2", "c3"].map((t) => make(t, "cancelled"));
  const elsewhere = ["e1", "e2"].map((t) => make(t, "done", other.id));
  const open = make("still open", "todo");
  return { ...f, other, epic, done, cancelled, elsewhere, open, now: () => T0 + day * DAY, at };
}

const titles = (list: { title: string }[]) => list.map((i) => i.title).sort();

describe("items.windowed", () => {
  it("holds every open ticket and epic, and the newest of each closed status by when it closed", async () => {
    const s = await seed();
    const got = s.items.windowed(s.project.id, { limit: 2, days: null });
    expect(titles(got)).toEqual(titles([s.epic, s.open, ...s.elsewhere, s.cancelled[1], s.cancelled[2]]));
  });

  it("orders by the status change, not the last edit", async () => {
    const s = await seed();
    s.at();
    // The oldest done ticket is edited last; it closed first, so it stays out.
    s.items.update(s.project.id, s.done[0].id, { title: "d1 renamed" }, "human");
    const got = s.items.windowed(s.project.id, { limit: 3, days: null }).filter((i) => i.kind === "ticket" && i.status === "done");
    expect(titles(got)).toEqual(["d4", "e1", "e2"]);
  });

  it("keeps only the last days when asked, and everything with no bound", async () => {
    const s = await seed();
    const recent = s.items.windowed(s.project.id, { limit: null, days: 3 }).filter((i) => i.kind === "ticket" && i.status !== "todo");
    expect(titles(recent)).toEqual(["e1", "e2"]);
    expect(s.items.windowed(s.project.id, { limit: null, days: null })).toHaveLength(s.items.list({ projectId: s.project.id }).length);
  });

  it("reaches a reopened ticket whatever its age", async () => {
    const s = await seed();
    s.at();
    s.items.update(s.project.id, s.done[0].id, { status: "doing" }, "human");
    expect(s.items.windowed(s.project.id, { limit: 1, days: null }).some((i) => i.id === s.done[0].id)).toBe(true);
  });
});

describe("a closed column's pages", () => {
  const inBoard = (id: string): FilterClause[] => [{ field: "board", op: "in", values: [id] }];
  const status = (value: string): FilterClause => ({ field: "status", op: "in", values: [value] });

  it("pages newest first within the view's filter, and counts the whole column", async () => {
    const s = await seed();
    const filter = [...inBoard(s.board.id), status("done")];
    const page = (limit: number) => s.items.query({ projectId: s.project.id, filter, ticketsOnly: true, newestClosedFirst: true, limit }).map((i) => i.title);
    expect(page(2)).toEqual(["d4", "d3"]);
    expect(page(3)).toEqual(["d4", "d3", "d2"]);
    expect(s.items.count({ projectId: s.project.id, filter, ticketsOnly: true })).toBe(4);
    expect(s.items.count({ projectId: s.project.id, filter: [status("done")], ticketsOnly: true })).toBe(6);
    // The done epic is no ticket.
    expect(s.items.count({ projectId: s.project.id, filter: [status("done")] })).toBe(7);
  });

  it("a page holds whatever the window already showed of that column", async () => {
    const s = await seed();
    const window = s.items.windowed(s.project.id, { limit: 3, days: null });
    const shown = window.filter((i) => i.kind === "ticket" && i.status === "done" && i.boardId === s.board.id).map((i) => i.id);
    const next = s.items.query({ projectId: s.project.id, filter: [...inBoard(s.board.id), status("done")], ticketsOnly: true, newestClosedFirst: true, limit: shown.length + 1 }).map((i) => i.id);
    expect(next).toEqual(expect.arrayContaining(shown));
    expect(next).toHaveLength(shown.length + 1);
  });

  it("counts with a search too", async () => {
    const s = await seed();
    expect(s.items.count({ projectId: s.project.id, filter: [status("cancelled")], search: "c2" })).toBe(1);
  });
});

describe("items.epicProgress", () => {
  it("counts an epic's tickets where they all are, cancelled ones on neither side", async () => {
    const s = await seed();
    for (const t of [...s.done, s.cancelled[0], s.open]) s.items.update(s.project.id, t.id, { parentId: s.epic.id }, "human");
    expect(s.items.epicProgress(s.project.id)).toEqual({ [s.epic.id]: { done: 4, total: 5 } });
  });
});

describe("the closed window setting", () => {
  it("takes a bound per project and refuses one that is not a positive whole number", () => {
    const parse = (v: unknown) => CLOSED_WINDOW_SECTION.schema.safeParse(v).success;
    expect(parse({ p1: DEFAULT_CLOSED_WINDOW, p2: { limit: null, days: 30 } })).toBe(true);
    expect(parse({ p1: { limit: 0, days: null } })).toBe(false);
    expect(parse({ p1: { limit: 2.5, days: null } })).toBe(false);
    expect(parse({ p1: { limit: 50 } })).toBe(false);
  });

  it("is registered with Settings, empty until a project sets one", async () => {
    const file = path.join(os.tmpdir(), `tomrade-closed-window-${Date.now()}-${Math.random()}.json`);
    const s = await fresh({ plugins: [[Settings, { path: file }]] });
    expect(s.ctx.settings.get().closedWindow).toEqual({});
    s.ctx.settings.set({ ...s.ctx.settings.get(), closedWindow: { [s.project.id]: { limit: 20, days: 14 } } });
    expect(s.ctx.settings.get().closedWindow).toEqual({ [s.project.id]: { limit: 20, days: 14 } });
  });
});
