import { z } from "zod";
import { definePlugin, defineTool, type Item } from "@tomrade/plugin-sdk";

const DAY = 86_400_000;
const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);

const settingsSchema = z.object({
  days: z.number().int().min(1).describe("Days without a write before an open issue counts as stale")
});

/**
 * Stale-issue watch. An open issue nobody has written to for `days` gets a
 * badge, a status-bar count and a detail section; a human can acknowledge it
 * from the palette, and the next write to the issue clears the acknowledgement.
 */
export default definePlugin({
  name: "stale",
  inject: ["db", "settings", "items", "tools", "contributions"],
  apply(ctx) {
    ctx.db.migrate("stale", [{ version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_stale_acks (item_id TEXT PRIMARY KEY, acked_at INTEGER NOT NULL)" }]);
    ctx.settings.register({ id: "stale", title: "Stale issues", description: "Open issues nobody has written to for a while get a badge and a status-bar count.", schema: settingsSchema, defaults: { days: 14 } });

    const days = () => (ctx.settings.get().stale as z.infer<typeof settingsSchema>).days;
    const acked = (id: string) => !!ctx.db.prepare("SELECT 1 FROM plugin_stale_acks WHERE item_id = ?").get(id);
    const idleDays = (item: Item, now = Date.now()) => Math.floor((now - item.updatedAt) / DAY);
    const isStale = (item: Item) => OPEN.has(item.status) && idleDays(item) >= days() && !acked(item.id);
    const staleIn = (projectId?: string) => ctx.items.list(projectId ? { projectId } : {}).filter(isStale);

    ctx.on("write/committed", (intent) => {
      if (intent.entity === "item") ctx.db.prepare("DELETE FROM plugin_stale_acks WHERE item_id = ?").run(intent.id);
    });

    ctx.tools.register(
      defineTool({
        name: "list_stale_items",
        title: "List stale items",
        description: "Open issues with no write for the configured number of days, oldest first.",
        input: z.object({ projectId: z.string().optional() }),
        execute: ({ projectId }, inv) => staleIn(projectId ?? inv.projectId).sort((a, b) => a.updatedAt - b.updatedAt)
      })
    );

    ctx.contributions.badge({
      id: "stale",
      compute: (items) => Object.fromEntries(items.filter(isStale).map((i) => [i.id, [{ id: "stale", label: "stale", tone: "strong", title: `No write for ${idleDays(i)} days` }]]))
    });
    ctx.contributions.statusItem({
      id: "stale",
      text: ({ projectId }) => {
        const n = staleIn(projectId).length;
        return n ? `${n} stale` : null;
      }
    });
    ctx.contributions.section({
      id: "stale",
      title: "Staleness",
      render: (item) => (isStale(item) ? { rows: [{ label: "Idle", value: `${idleDays(item)} days` }], text: "Acknowledge from the palette to clear the badge until the next write." } : null)
    });
    ctx.contributions.command({
      id: "stale.ack",
      title: "Acknowledge stale issue",
      group: "Stale issues",
      run: ({ itemId }) => {
        if (!itemId) return { toast: "Select an issue first" };
        ctx.db.prepare("INSERT OR REPLACE INTO plugin_stale_acks (item_id, acked_at) VALUES (?, ?)").run(itemId, Date.now());
        return { toast: "Acknowledged — the badge is gone until the next write" };
      }
    });
  }
});
