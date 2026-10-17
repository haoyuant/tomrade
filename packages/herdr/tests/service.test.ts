import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { Herdr, type HerdrPaneEvent } from "@tomradex/herdr";
import { FakeHerdr } from "@tomradex/testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-service-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function herdrOn(fake: FakeHerdr): Promise<{ ctx: Context; herdr: Herdr }> {
  const ctx = new Context();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  return { ctx, herdr: ctx.herdr };
}

const until = async (check: () => boolean, timeout = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("herdr service", () => {
  it("launches a command in a workspace of its own, unfocused, typed with Enter, and reads and prompts the pane", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const launched = await herdr.launch({ cwd: "/work/tom-7", label: "TOM-7", command: "bash '/sessions/s1/run.command'" });
    expect(launched).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(fake.of("workspace.create")).toEqual([{ cwd: "/work/tom-7", label: "TOM-7", focus: false }]);
    expect(fake.of("pane.send_input")).toEqual([{ pane_id: "w1:p1", text: "bash '/sessions/s1/run.command'", keys: ["enter"] }]);
    expect(await herdr.paneAlive("w1:p1")).toBe(true);
    expect(await herdr.paneAlive("w9:p9")).toBe(false);

    // No agent in the pane yet: nothing to prompt. With one, the text goes in; blocked, it does not.
    expect(await herdr.prompt("w1:p1", "go")).toBe(false);
    fake.panes.get("w1:p1")!.agent = "claude";
    fake.panes.get("w1:p1")!.text = "❯ working on it\nDone: scaffold in place.\n> \n? for shortcuts";
    expect(await herdr.prompt("w1:p1", "go")).toBe(true);
    expect(fake.of("agent.prompt")).toEqual([{ target: "w1:p1", text: "go" }, { target: "w1:p1", text: "go" }]);
    fake.panes.get("w1:p1")!.agent_status = "blocked";
    expect(await herdr.prompt("w1:p1", "go")).toBe(false);
    expect(await herdr.readTail("w1:p1")).toContain("Done: scaffold in place.");
    expect(fake.of("pane.read")[0]).toMatchObject({ pane_id: "w1:p1", source: "recent", lines: 20 });
    expect(await herdr.readTail("w9:p9")).toBeNull();

    fake.stop();
    expect(await herdr.launch({ cwd: "/work", command: "true" })).toBeNull();
    expect(await herdr.paneAlive("w1:p1")).toBeNull();
    expect(await herdr.server()).toBeNull();
  });

  it("follows a pane's status per pane, once per change, hears its end, and lets it go", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    const pane = fake.createPane("/work");
    // What the pane says when the watch starts is heard first, so a change made before counts.
    pane.agent = "claude";
    pane.agent_status = "working";
    herdr.watch(pane.pane_id);
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ kind: "status", paneId: "w1:p1", status: "working", agent: "claude" });
    await until(() => fake.of("events.subscribe").length === 2);
    expect(fake.of("events.subscribe")).toEqual(expect.arrayContaining([{ subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }] }, { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] }]));

    fake.setStatus("w1:p1", "claude", "working");
    fake.setStatus("w1:p1", "claude", "blocked");
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ kind: "status", paneId: "w1:p1", status: "blocked", agent: "claude" });
    fake.setStatus("w1:p1", "claude", "done");
    await until(() => heard.length === 3);
    expect(heard[2]).toMatchObject({ status: "done" });

    // Another pane, not watched, is nobody's business.
    const other = fake.createPane("/elsewhere");
    fake.setStatus(other.pane_id, "codex", "working");
    fake.exit(other.pane_id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.length).toBe(3);

    fake.exit("w1:p1");
    await until(() => heard.length === 4);
    expect(heard[3]).toEqual({ kind: "exited", paneId: "w1:p1" });
    expect(herdr.watching()).toEqual([]);
  });

  it("subscribes again when herdr comes back, and reports a watched pane that went while it was away", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    const kept = fake.createPane("/kept");
    const lost = fake.createPane("/lost");
    herdr.watch(kept.pane_id);
    herdr.watch(lost.pane_id);
    await until(() => fake.of("events.subscribe").length === 3);

    fake.stop();
    fake.panes.delete(lost.pane_id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heard).toEqual([]);
    fake.start();
    await until(() => heard.some((event) => event.kind === "exited" && event.paneId === lost.pane_id));
    expect(herdr.watching()).toEqual([kept.pane_id]);
    // …and the kept pane is followed again.
    fake.setStatus(kept.pane_id, "claude", "blocked");
    await until(() => heard.some((event) => event.kind === "status" && event.paneId === kept.pane_id && event.status === "blocked"));
    fake.close();
  });

  it("watches a pane herdr no longer has as already over", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    herdr.watch("w4:p1");
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ kind: "exited", paneId: "w4:p1" });
    expect(herdr.watching()).toEqual([]);
    fake.close();
  });
});
