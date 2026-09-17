/**
 * Search runs in SQL over the trigram index: a substring match in any script,
 * every word required in either column, most relevant first. Words too short
 * for a trigram fall back to instr(), and the index follows every write.
 */
import { describe, expect, it } from "vitest";
import { fresh } from "@tomrade/testkit";

async function seed() {
  const f = await fresh();
  const { items, board, project } = f;
  const mk = (title: string, body?: string) => items.create({ projectId: project.id, boardId: board.id, title, body, by: "human" });
  const dark = mk("Dark mode toggle", "Add a dark theme");
  const light = mk("Light mode", "Nothing dark here at all, in a much longer body about themes and other things");
  const auth = mk("用户认证系统", "登录失败时提示 TOM-42");
  const titles = (search: string) => items.list({ projectId: project.id, search }).map((i) => i.title);
  return { ...f, dark, light, auth, titles };
}

describe("items search", () => {
  it("matches title or body, case-insensitively, most relevant first", async () => {
    const { titles } = await seed();
    expect(titles("DARK")).toEqual(["Dark mode toggle", "Light mode"]);
    expect(titles("   ")).toHaveLength(3);
  });

  it("requires every word, in any order and either column", async () => {
    const { titles } = await seed();
    expect(titles("toggle theme")).toEqual(["Dark mode toggle"]);
    expect(titles("theme toggle")).toEqual(["Dark mode toggle"]);
    expect(titles("toggle nothing")).toEqual([]);
  });

  it("is a substring match in any script; two characters still find a match", async () => {
    const { titles } = await seed();
    expect(titles("认证系统")).toEqual(["用户认证系统"]);
    expect(titles("认证")).toEqual(["用户认证系统"]);
    expect(titles("tom-42")).toEqual(["用户认证系统"]);
    expect(titles("认证 42")).toEqual(["用户认证系统"]);
  });

  it("a quoted run is one contiguous term; other FTS syntax is text", async () => {
    const { titles } = await seed();
    expect(titles('"mode toggle"')).toEqual(["Dark mode toggle"]);
    expect(titles('"toggle mode"')).toEqual([]);
    expect(titles("“认证系统”")).toEqual(["用户认证系统"]);
    expect(titles('"dark" toggle')).toEqual(["Dark mode toggle"]);
    expect(titles('"unclosed dark')).toEqual([]);
    expect(titles("(dark)")).toEqual([]);
    expect(titles("mode OR")).toEqual([]);
  });

  it("widening falls back to any term only when every term finds nothing", async () => {
    const { items, project } = await seed();
    const list = (search: string, extra: object = {}) => items.list({ projectId: project.id, search, widen: true, ...extra }).map((i) => i.title);
    expect(list("toggle nothing").sort()).toEqual(["Dark mode toggle", "Light mode"]);
    expect(list("dark")).toEqual(["Dark mode toggle", "Light mode"]);
    expect(list("zebra")).toEqual([]);
    expect(list("zebra giraffe")).toEqual([]);
    // Two matched terms outrank one; a short term alone still reaches the row.
    expect(list("dark toggle zebra")[0]).toBe("Dark mode toggle");
    expect(list("认证 zebra")).toEqual(["用户认证系统"]);
    expect(list("toggle nothing", { limit: 1 })).toHaveLength(1);
    expect(items.query({ projectId: project.id, search: "toggle nothing", widen: true }).map((i) => i.title).sort()).toEqual(["Dark mode toggle", "Light mode"]);
    expect(items.query({ projectId: project.id, search: "toggle nothing" })).toEqual([]);
  });

  it("a title hit outranks a body hit, in the index and in the short-word fallback", async () => {
    const { items, project, board, titles } = await seed();
    const mk = (title: string, body: string) => items.create({ projectId: project.id, boardId: board.id, title, body, by: "human" });
    mk("Sidebar spacing", "The UI is cramped and the theme is off");
    mk("UI polish", "Small fixes");
    mk("Theme picker", "Choose a theme");
    expect(titles("UI")).toEqual(["UI polish", "Sidebar spacing"]);
    const theme = titles("theme");
    expect(theme[0]).toBe("Theme picker");
    expect(theme).toHaveLength(4);
  });

  it("follows updates, deletes and undo", async () => {
    const { ctx, items, project, dark, titles } = await seed();
    items.update(project.id, dark.id, { title: "Bright mode toggle", body: null }, "human");
    expect(titles("dark")).toEqual(["Light mode"]);
    expect(titles("bright")).toEqual(["Bright mode toggle"]);
    items.delete(project.id, dark.id, "human");
    expect(titles("bright")).toEqual([]);
    await ctx.oplog.undo(project.id);
    expect(titles("bright")).toEqual(["Bright mode toggle"]);
  });

  it("a limit keeps the front of the order, on both paths", async () => {
    const { items, project } = await seed();
    const list = (extra: object) => items.list({ projectId: project.id, ...extra }).map((i) => i.title);
    expect(list({ search: "dark", limit: 1 })).toEqual(["Dark mode toggle"]);
    expect(list({ limit: 2 })).toHaveLength(2);
    expect(items.query({ projectId: project.id, search: "dark", limit: 1 }).map((i) => i.title)).toEqual(["Dark mode toggle"]);
    expect(items.query({ projectId: project.id, sortBy: [{ field: "title", dir: "desc" }], limit: 1 }).map((i) => i.title)).toEqual(["用户认证系统"]);
  });

  it("narrows a clause query; an explicit sort comes before relevance", async () => {
    const { items, project, light } = await seed();
    items.update(project.id, light.id, { status: "todo" }, "human");
    const q = (search: string, extra: object) => items.query({ projectId: project.id, search, ...extra }).map((i) => i.title);
    expect(q("mode", { filter: [{ field: "status", op: "in", values: ["todo"] }] })).toEqual(["Light mode"]);
    expect(q("dark", {})).toEqual(["Dark mode toggle", "Light mode"]);
    expect(q("dark", { sortBy: [{ field: "title", dir: "desc" }] })).toEqual(["Light mode", "Dark mode toggle"]);
  });
});
