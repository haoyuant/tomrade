/**
 * The guarantees are a plugin. Loaded, the write path refuses what it should;
 * unloaded, the same calls go through — which is what proves they live here.
 */
import { describe, expect, it } from "vitest";
import { ConflictError, HumanLockedError, PurgeNotPermittedError } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";
import { humanLock, humanOnlyPurge, optimisticVersion } from "@tomrade/write";

describe("write policy as a plugin", () => {
  it("without the policy row, an agent can overwrite a locked title, ignore staleness and purge", async () => {
    const { items, board, project } = await fresh({ policy: false });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(items.update(project.id, item.id, { title: "rewritten" }, "ai:mcp", { baseVersion: 1 }).title).toBe("rewritten");
    expect(() => items.purge(project.id, item.id, "ai:mcp")).not.toThrow();
  });

  it("each guarantee is its own plugin", async () => {
    const { items, board, project } = await fresh({ policy: false, plugins: [optimisticVersion] });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(() => items.update(project.id, item.id, { title: "x" }, "ai:mcp", { baseVersion: 1 })).toThrow(ConflictError);
    expect(items.update(project.id, item.id, { title: "x" }, "ai:mcp", { baseVersion: 2 }).title).toBe("x");
  });

  it("the human lock alone protects title and body but not staleness", async () => {
    const { items, board, project } = await fresh({ policy: false, plugins: [humanLock] });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(() => items.update(project.id, item.id, { title: "x" }, "ai:mcp")).toThrow(HumanLockedError);
    expect(items.update(project.id, item.id, { status: "done" }, "ai:mcp", { baseVersion: 1 }).status).toBe("done");
  });

  it("unloading the policy at runtime removes its listeners", async () => {
    const { ctx, items, board, project } = await fresh({ policy: false });
    const fiber = await ctx.plugin(humanOnlyPurge);
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(() => items.purge(project.id, item.id, "ai:mcp")).toThrow(PurgeNotPermittedError);
    await fiber.dispose();
    expect(() => items.purge(project.id, item.id, "ai:mcp")).not.toThrow();
  });

  it("a third-party policy can refuse a write, and its refusal reaches the caller", async () => {
    const { ctx, items, board, project } = await fresh();
    class QuotaError extends Error {}
    ctx.on("write/pre-commit", (intent, next) => {
      if (intent.by === "ai:noisy" && intent.op === "create") throw new QuotaError("ai:noisy is over quota");
      return next();
    });
    expect(() => items.create({ projectId: project.id, title: "spam", boardId: board.id, by: "ai:noisy" })).toThrow(QuotaError);
    expect(items.list().length).toBe(0);
    expect(items.create({ projectId: project.id, title: "fine", boardId: board.id, by: "ai:quiet" }).title).toBe("fine");
  });

  it("every intent names its project, so a policy can read the right file", async () => {
    const { ctx, items, board, project } = await fresh();
    const seen: string[] = [];
    ctx.on("write/pre-commit", (intent, next) => {
      seen.push(intent.projectId);
      return next();
    });
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(seen).toEqual([project.id]);
  });

  it("a listener that neither refuses nor delegates is reported, and nothing is committed", async () => {
    const { ctx, items, board, project } = await fresh();
    ctx.on("write/pre-commit", () => undefined);
    expect(() => items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" })).toThrow(/neither refused nor called next/);
    expect(items.list().length).toBe(0);
  });
});
