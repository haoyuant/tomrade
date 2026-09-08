/**
 * Decisions are text in the project's own folder: numbered notes an agent reads
 * before it touches a cross-cutting area, and writes once the user has settled
 * one — so no ticket makes the same choice twice, or silently.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodeLink, covered, firstPrompt, listDecisions, recordDecision } from "@tomrade/code-link";
import { Contributions } from "@tomrade/contributions";
import { Repos } from "@tomrade/repos";
import { Settings } from "@tomrade/settings";
import { Storage } from "@tomrade/storage";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-decisions-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

describe("decision notes", () => {
  it("are numbered, carry their areas, and can supersede one another", () => {
    const dir = path.join(root, `p-${n++}`);
    const first = recordDecision(dir, { title: "State: Riverpod", context: "Flutter app, several screens share auth and cart state", decision: "Riverpod with code generation", alternatives: "Bloc, plain ChangeNotifier", areas: ["state management"] }, new Date("2026-09-08T00:00:00Z"));
    expect(first).toMatchObject({ id: "0001", status: "accepted", areas: ["state management"], date: "2026-09-08" });
    expect(path.basename(first.file)).toBe("0001-state-riverpod.md");
    const text = fs.readFileSync(first.file, "utf8");
    expect(text).toMatch(/^---\ntitle: "State: Riverpod"\nstatus: accepted\n/);
    expect(text).toContain("## Alternatives considered\n\nBloc, plain ChangeNotifier");

    const second = recordDecision(dir, { title: "Routing: go_router", context: "deep links", decision: "go_router", areas: ["routing"], status: "proposed" });
    expect(second.id).toBe("0002");
    const third = recordDecision(dir, { title: "State: Bloc after all", context: "team knows it", decision: "Bloc", areas: ["state management"], supersedes: "0001" });
    expect(third.id).toBe("0003");

    const all = listDecisions(dir);
    expect(all.map((d) => [d.id, d.status])).toEqual([
      ["0001", "superseded"],
      ["0002", "proposed"],
      ["0003", "accepted"]
    ]);
    expect(covered(all, "State Management")).toBe(true);
    expect(covered(all, "routing")).toBe(false); // proposed is not settled
    expect(covered(all, "deployment")).toBe(false);
    expect(listDecisions(path.join(root, "nowhere"))).toEqual([]);
  });

  it("reach the agent through tools, and the first prompt names what is settled", async () => {
    const hubDir = path.join(root, `hub-${n++}`);
    fs.mkdirSync(hubDir, { recursive: true });
    const bag = await fresh({
      hubDir,
      plugins: [Tools, [Settings, { path: path.join(hubDir, "settings.json") }], [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Repos, Contributions, [CodeLink, { scanMs: 0 }]]
    });
    await settle();
    await bag.ctx.storage.ready;
    const { ctx, project, board, items } = bag;
    const scope = { by: "ai:claude-code" as const, projectId: project.id };

    const before = (await ctx.tools.execute("list_decisions", { area: "state management" }, scope)) as { decisions: unknown[]; covered: boolean };
    expect(before).toEqual({ decisions: [], area: "state management", covered: false });

    const written = (await ctx.tools.execute("record_decision", { title: "State: Riverpod", context: "shared state", decision: "Riverpod", areas: ["state management"] }, scope)) as { id: string; path: string };
    expect(written.id).toBe("0001");
    expect(written.path).toContain(path.join(".tomrade", "docs", "decisions"));
    expect(fs.existsSync(written.path)).toBe(true);

    const after = (await ctx.tools.execute("list_decisions", { area: "state" }, scope)) as { decisions: { title: string }[]; covered: boolean };
    expect(after.covered).toBe(true);
    expect(after.decisions.map((d) => d.title)).toEqual(["State: Riverpod"]);

    const item = items.create({ projectId: project.id, boardId: board.id, title: "Cart badge", status: "todo", by: "human" });
    const repo = ctx.repos.create({ projectId: project.id, remote: "git@github.com:acme/app.git" });
    const prompt = firstPrompt({ item, repo, state: null, branch: "tom-1/cart-badge", blockers: [], bootstrap: false, mcpUrl: null, decisions: listDecisions(ctx.storage.artifactDirFor(project.id)!) });
    expect(prompt).toContain("blocked: push");
    expect(prompt).toContain("the human owns credentials");
    expect(prompt).toContain("Decisions on record");
    expect(prompt).toContain("0001 State: Riverpod [state management]");
  });
});
