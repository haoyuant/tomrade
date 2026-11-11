import type { Context } from "cordis";
import { contract } from "@tomradex/contracts";
import type { SessionView } from "./store.js";

/** How a session reads to someone at another machine. */
export function summaryState(session: Pick<SessionView, "state" | "blocked">): "working" | "waiting" | "blocked" {
  if (session.blocked || session.state === "error") return "blocked";
  return session.state === "running" ? "working" : "waiting";
}

/**
 * The tickets this machine's live sessions hold, told to the account's other machines whenever a session
 * changes. Only a ticket's key and title, the agent, a state, a time and the branch are named: no
 * conversation, no prompt, no folder. Without an account service, nothing is told.
 */
export function tellDeviceSessions(ctx: Context, live: (projectId: string) => SessionView[]): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tell = () => {
    timer = null;
    const cloud = contract(ctx, "cloudHub");
    if (!cloud?.reportActivity) return;
    const entries: Record<string, unknown>[] = [];
    for (const projectId of ctx.db.openIds()) {
      for (const session of live(projectId)) {
        if (session.state === "ended" || session.state === "lost") continue;
        for (const itemId of session.itemIds) {
          const item = ctx.items.get(projectId, itemId);
          if (item) entries.push({ projectId, key: item.key, title: item.title, agent: session.agent, state: summaryState(session), startedAt: session.startedAt, branch: session.branch || null });
        }
      }
    }
    cloud.reportActivity("sessions", entries);
  };
  // A session's hooks arrive in bursts: one reading for each.
  const soon = () => {
    timer ??= setTimeout(tell, 250);
    timer.unref?.();
  };
  ctx.on("codeLink/changed", soon);
  ctx.on("db/opened", soon);
  // The account service may load after this one.
  ctx.inject(["cloudHub"], soon);
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer);
  }, "device sessions summary");
  soon();
}
