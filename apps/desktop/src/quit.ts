import { dialog } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/storage";

let approved = false;
let pending: Promise<boolean> | null = null;

/**
 * Everything a quit owes before it happens: the person's word on agent runs in
 * flight, then the last quiet window published. False when they keep the app.
 * A write never waits on a push, so the flush runs here, with a deadline,
 * because quitting must not hang on a remote. Two quits asked at once share
 * one answer, and a fault here never holds the app open.
 */
export function prepareToQuit(ctx: Context): Promise<boolean> {
  if (approved) return Promise.resolve(true);
  pending ??= ask(ctx)
    .catch(() => true)
    .then((ok) => {
      pending = null;
      approved = ok;
      return ok;
    });
  return pending;
}

async function ask(ctx: Context): Promise<boolean> {
  // A coding run in flight dies with the process. Its session is kept and the
  // ticket offers Continue afterwards, but the person decides — no daemon.
  const active = ctx.get("agent")?.activeRuns() ?? [];
  if (active.length) {
    const code = active.filter((a) => a.thread.itemId).length;
    const zh = ctx.get("settings")?.locale?.() === "zh";
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: zh ? ["退出", "取消"] : ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: zh ? `有 ${active.length} 个代理运行正在进行` : `${active.length} agent run${active.length === 1 ? " is" : "s are"} in progress`,
      detail: zh
        ? code ? `其中 ${code} 个在实现工作项。退出会中断它们；每个工作项都会保留分支，之后可以继续。` : "退出会中断它们。"
        : code ? `${code} of them implement${code === 1 ? "s" : ""} a ticket. Quitting interrupts them; each ticket keeps its branch and offers Continue.` : "Quitting interrupts them."
    });
    if (choice === 1) return false;
  }
  const storage = ctx.get("storage");
  if (storage) await Promise.race([storage.flushAll("quit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  return true;
}

export const quitApproved = () => approved;

/** A quit that did not happen after all, like an install that failed: the next one asks and flushes again. */
export function cancelQuit(): void {
  approved = false;
}
