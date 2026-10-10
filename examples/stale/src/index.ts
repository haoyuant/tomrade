import { z } from "zod";
import { definePlugin, defineTool, requireProjectId, type Item } from "@tomradex/plugin-sdk";

const DAY = 86_400_000;
const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);

const Settings = z.object({
  days: z.number().int().min(1).describe("Days without a write before an open issue counts as stale")
});
type Settings = z.infer<typeof Settings>;

/**
 * Stale-issue watch. An open issue nobody has written to for `days` gets a
 * badge, a status-bar count and a detail section; a human can acknowledge it
 * from the palette, and the next write to the issue clears the acknowledgement.
 */
export default definePlugin({
  inject: ["db", "settings", "items", "tools", "contributions"],
  async apply(ctx) {
    // The declaration is what lets the acks be deleted with their project and left out of its folder.
    await ctx.db.migrate([{ version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_stale_acks (item_id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', acked_at INTEGER NOT NULL)" }], {
      tables: { plugin_stale_acks: { project: "project_id", export: false } }
    });
    await ctx.settings.register({ title: "Stale issues", description: "Open issues nobody has written to for a while get a badge and a status-bar count.", schema: Settings, defaults: { days: 14 } });

    const idleDays = (item: Item, now = Date.now()) => Math.floor((now - item.updatedAt) / DAY);
    /** One read of the threshold and the acknowledgements per refresh, not one per issue. */
    const staleFilter = async (projectId: string) => {
      const { days } = await ctx.settings.get<Settings>();
      const acked = new Set((await ctx.db.all<{ item_id: string }>(projectId, "SELECT item_id FROM plugin_stale_acks WHERE project_id = ?", [projectId])).map((r) => r.item_id));
      return (item: Item) => OPEN.has(item.status) && idleDays(item) >= days && !acked.has(item.id);
    };
    const staleIn = async (projectId: string) => {
      const isStale = await staleFilter(projectId);
      return (await ctx.items.list({ projectId })).filter(isStale);
    };

    ctx.on("write", async (event) => {
      if (event.entity === "item") await ctx.db.run(event.projectId, "DELETE FROM plugin_stale_acks WHERE item_id = ?", [event.id]);
    });

    await ctx.tools.register(
      defineTool({
        name: "stale_list_items",
        title: "List stale items",
        description: "Open issues with no write for the configured number of days, oldest first.",
        input: z.object({ projectId: z.string().optional() }),
        execute: async ({ projectId }, inv) => (await staleIn(requireProjectId("stale_list_items", projectId, inv))).sort((a, b) => a.updatedAt - b.updatedAt)
      })
    );

    await ctx.contributions.badge({
      id: "stale",
      compute: async (items, { projectId }) => {
        const isStale = await staleFilter(projectId);
        return Object.fromEntries(items.filter(isStale).map((i) => [i.id, [{ id: "stale", label: "stale", tone: "strong" as const, title: `No write for ${idleDays(i)} days` }]]));
      }
    });
    await ctx.contributions.statusItem({
      id: "stale",
      text: async ({ projectId }) => {
        if (!projectId) return null;
        const n = (await staleIn(projectId)).length;
        return n ? `${n} stale` : null;
      }
    });
    await ctx.contributions.section({
      id: "stale",
      title: "Staleness",
      render: async (item) =>
        (await staleFilter(item.projectId))(item) ? { rows: [{ label: "Idle", value: `${idleDays(item)} days` }], text: "Acknowledge from the palette to clear the badge until the next write." } : null
    });
    await ctx.contributions.command({
      id: "stale.ack",
      title: "Acknowledge stale issue",
      group: "Stale issues",
      run: async ({ projectId, itemId }) => {
        if (!projectId || !itemId) return { toast: "Select an issue first" };
        await ctx.db.run(projectId, "INSERT OR REPLACE INTO plugin_stale_acks (item_id, project_id, acked_at) VALUES (?, ?, ?)", [itemId, projectId, Date.now()]);
        return { toast: "Acknowledged — the badge is gone until the next write" };
      }
    });
  }
});
