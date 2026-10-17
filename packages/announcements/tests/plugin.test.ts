import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { expect, it } from "vitest";
import * as Announcements from "@tomradex/announcements";
import { Contributions } from "@tomradex/contributions";
import { fresh, settle } from "@tomradex/testkit";

class FakeIpc extends Service {
  static provide = "ipc";
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  sent: unknown[][] = [];
  handle(channel: string, handler: (...args: never[]) => unknown) {
    return this.ctx.effect(() => {
      this.handlers.set(channel, handler as (...args: unknown[]) => unknown);
      return () => this.handlers.delete(channel);
    });
  }
  send(channel: string, ...args: unknown[]) {
    this.sent.push([channel, ...args]);
  }
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, body: "hi", level: "info", locale: null, versions: null, starts_at: "2026-10-17T08:00:00.000Z", ...extra });

it("lists what this version should see, keeps what was shown across restarts, and survives an offline feed", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "announce-")), "announcements.json");
  let rows: unknown[] = [row("b", { level: "important", locale: "zh" }), row("a"), row("old", { versions: "<0.5.0" })];
  let failing = true;
  const queries: string[] = [];
  const hub = {
    name: "fake-cloud-hub",
    apply(ctx: Context) {
      ctx.provide("cloudHub", {
        client: {
          from: (table: string) => ({
            select: (columns: string) => ({
              order: () => ({
                limit: async () => {
                  queries.push(`${table}: ${columns}`);
                  return failing ? { data: null, error: { message: "offline" } } : { data: rows, error: null };
                }
              })
            })
          })
        }
      } as never);
    }
  };
  const boot = async () => {
    const ctx = new Context();
    await ctx.plugin(FakeIpc);
    await ctx.plugin(hub);
    const plugin = await ctx.plugin(Announcements, { file, version: "0.8.0" });
    await settle();
    return { plugin, ipc: ctx.ipc as unknown as FakeIpc };
  };

  let { plugin, ipc } = await boot();
  const list = () => ipc.handlers.get("announcements.list")!() as Promise<Announcements.Announcement[]>;
  expect(await list()).toEqual([]);
  failing = false;
  expect((await list()).map((a) => [a.id, a.level, a.locale, a.seen])).toEqual([["b", "important", "zh", false], ["a", "info", null, false]]);
  expect(queries.at(-1)).toBe("tomrade_announcements: id, title, body, level, locale, versions, starts_at");
  expect(ipc.sent.map(([channel]) => channel)).toEqual(["announcements.changed"]);

  const after = (await ipc.handlers.get("announcements.markSeen")!("a")) as Announcements.Announcement[];
  expect(after.find((a) => a.id === "a")!.seen).toBe(true);
  await plugin.dispose();

  ({ plugin, ipc } = await boot());
  rows = [row("a")];
  expect((await list()).map((a) => [a.id, a.seen])).toEqual([["a", true]]);
  await plugin.dispose();
});

it("offers the announcements from the palette, to read again", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "announce-")), "announcements.json");
  const f = await fresh({ plugins: [FakeIpc, Contributions, [Announcements, { file, version: "0.8.0" }]] });
  expect(f.ctx.contributions.commands().find((c) => c.id === "announcements.open")).toEqual({ id: "announcements.open", title: "Announcements…", group: "Help" });
  expect(await f.ctx.contributions.run("announcements.open", {})).toEqual({ opens: "announcements" });
});
