import { definePlugin, type Item } from "@tomrade/plugin-sdk";

const open = (item: Item) => item.status !== "done" && item.status !== "cancelled";

/** Whether `to` can reach back to `from`, i.e. the edge from→to sits on a cycle. */
function onCycle(from: string, to: string, blocksOf: Map<string, string[]>): boolean {
  const seen = new Set<string>([to]);
  const queue = [to];
  while (queue.length) {
    const node = queue.pop()!;
    if (node === from) return true;
    for (const next of blocksOf.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * The dependency lens over `Item.blocks`. The platform stores the edges and the
 * renderer owns the canvas; this plugin only says what the arrows mean — which
 * ones exist, which are already satisfied, which close a loop — and marks the
 * issues that are waiting on unfinished work.
 */
export default definePlugin({
  name: "deps-graph",
  inject: ["items", "contributions"],
  apply(ctx) {
    ctx.contributions.graph({
      id: "deps",
      title: "Dependencies",
      icon: "i-graph",
      edits: "blocks",
      compute(items) {
        const byId = new Map(items.map((i) => [i.id, i]));
        const blocksOf = new Map(items.map((i) => [i.id, i.blocks]));
        return items.flatMap((item) =>
          item.blocks.flatMap((to) => {
            const target = byId.get(to);
            if (!target) return [];
            // A done blocker is a satisfied dependency; a loop is a modelling
            // error someone should see, not a layout curiosity.
            const tone = onCycle(item.id, to, blocksOf) ? ("danger" as const) : open(item) ? ("strong" as const) : ("faint" as const);
            return [{ from: item.id, to, tone, title: `${item.key} blocks ${target.key}` }];
          })
        );
      }
    });

    ctx.contributions.badge({
      id: "deps",
      compute(items) {
        const byId = new Map(items.map((i) => [i.id, i]));
        const blockersOf = new Map<string, Item[]>();
        for (const item of items) {
          if (!open(item)) continue;
          for (const to of item.blocks) {
            const bucket = blockersOf.get(to);
            if (bucket) bucket.push(item);
            else blockersOf.set(to, [item]);
          }
        }
        return Object.fromEntries(
          [...blockersOf.entries()]
            // a closed issue no longer waits on anything
            .filter(([id]) => {
              const item = byId.get(id);
              return !!item && open(item);
            })
            .map(([id, blockers]) => [id, [{ id: "blocked", label: "blocked", tone: "strong" as const, title: `Blocked by ${blockers.map((b) => b.key).join(", ")}` }]])
        );
      }
    });
  }
});
