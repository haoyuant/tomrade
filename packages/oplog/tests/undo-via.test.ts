import { describe, expect, it } from "vitest";
import { fresh } from "@tomrade/testkit";
import { ExtensionAuthorError } from "@tomrade/domain";
import { extensionScope } from "@tomrade/write";

const as = <T>(human: boolean, fn: () => T) => extensionScope.run({ pluginId: "stale", human }, fn);

describe("extension attribution", () => {
  it("stamps the extension on every write it makes and takes all of them back at once", async () => {
    const { items, oplog, project, board } = await fresh();
    const mine = items.create({ projectId: project.id, boardId: board.id, title: "by a person", by: "human" });
    const made = as(false, () => items.create({ projectId: project.id, boardId: board.id, title: "by the extension", by: "ai:stale" }));
    as(false, () => items.update(project.id, mine.id, { status: "doing" }, "ai:stale"));

    const recent = oplog.recent(project.id, 10);
    expect(recent.filter((e) => e.via === "stale").map((e) => e.op).sort()).toEqual(["create", "update"]);
    expect(recent.find((e) => e.entityId === mine.id && e.op === "create")?.via).toBeNull();

    const result = oplog.undoVia(project.id, "stale");
    expect(result.reverted).toBe(2);
    expect(items.get(project.id, made.id)).toBeNull();
    expect(items.get(project.id, mine.id)?.status).toBe(mine.status);
  });

  it("refuses a human's authorship unless a person drove the call", async () => {
    const { items, project, board } = await fresh();
    expect(() => as(false, () => items.create({ projectId: project.id, boardId: board.id, title: "spoof", by: "human" }))).toThrow(ExtensionAuthorError);
    const ok = as(true, () => items.create({ projectId: project.id, boardId: board.id, title: "asked for", by: "human" }));
    expect(ok.title).toBe("asked for");
    expect(() => as(false, () => items.purge(project.id, ok.id, "human"))).toThrow(ExtensionAuthorError);
  });

  it("keeps an extension's write that someone edited afterwards", async () => {
    const { items, oplog, project, board } = await fresh();
    const made = as(false, () => items.create({ projectId: project.id, boardId: board.id, title: "draft", by: "ai:stale" }));
    items.update(project.id, made.id, { title: "kept by a person" }, "human");
    const result = oplog.undoVia(project.id, "stale");
    expect(result.reverted).toBe(0);
    expect(result.kept[0]?.reason).toBe("edited after this run");
  });
});
