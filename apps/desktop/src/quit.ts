import { app, BrowserWindow, dialog } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/storage";

let approved = false;
let pending: Promise<boolean> | null = null;
// Windows put away while the quit finishes; the one in front is shown again first.
let away: { wins: BrowserWindow[]; front: BrowserWindow | null } | null = null;

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
      message: zh ? `有 ${active.length} 个智能体运行正在进行` : `${active.length} agent run${active.length === 1 ? " is" : "s are"} in progress`,
      detail: zh
        ? code ? `其中 ${code} 个在实现工作项。退出会中断它们；每个工作项都会保留分支，之后可以继续。` : "退出会中断它们。"
        : code ? `${code} of them implement${code === 1 ? "s" : ""} a ticket. Quitting interrupts them; each ticket keeps its branch and offers Continue.` : "Quitting interrupts them."
    });
    if (choice === 1) return false;
  }
  // The flush can wait on a remote; the person shouldn't. From here the app looks closed.
  putAway();
  const storage = ctx.get("storage");
  if (!storage) return true;
  await within(storage.flushAll("quit").catch(() => undefined), FLUSH_MS);
  return settleUnsynced(ctx);
}

const FLUSH_MS = 5_000;
/** How long "Wait" waits before asking again. */
const WAIT_MS = 60_000;
const within = (work: Promise<unknown>, ms: number) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * Writes that never left this machine are invisible to every other one — and to
 * another Tomrade on this one — until the next launch publishes them. The person
 * hears how many before they go, and can wait for them.
 */
async function settleUnsynced(ctx: Context): Promise<boolean> {
  const storage = ctx.get("storage");
  for (;;) {
    const left = storage?.pendingAll() ?? [];
    const total = left.reduce((sum, p) => sum + p.count, 0);
    if (!storage || !total) return true;
    const zh = ctx.get("settings")?.locale?.() === "zh";
    // The windows are away; the question must not be.
    if (process.platform === "darwin") app.show();
    const list = left.map((p) => (zh ? `${p.name}：${p.count} 条` : `${p.name}: ${p.count}`)).join("\n");
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: zh ? ["等待同步", "直接退出", "取消"] : ["Wait for sync", "Quit anyway", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: zh ? `还有 ${total} 条修改没有同步` : `${total} change${total === 1 ? " has" : "s have"} not synced yet`,
      detail: zh
        ? `${list}\n\n它们只在这台电脑的这个 Tomrade 里。直接退出的话，下次启动会继续同步；在那之前，其他设备和另一个 Tomrade 都看不到。`
        : `${list}\n\nThey are only in this Tomrade on this computer. Quit anyway and the next launch syncs them; until then no other device, and no other Tomrade here, sees them.`
    });
    if (choice === 1) return true;
    if (choice === 2) {
      cancelQuit();
      return false;
    }
    if (process.platform === "darwin") app.hide();
    // A full publish this time: it may fetch and merge, which a quit's own flush never does.
    await within(Promise.all(left.map((p) => storage.publish(p.projectId, "quit").catch(() => undefined))), WAIT_MS);
  }
}

/**
 * A signal (a development restart, a logout) ends the process without a quit to
 * ask through: the writes still get their one chance to leave, then it goes.
 */
export async function leaveOnSignal(ctx: Context): Promise<void> {
  const storage = ctx.get("storage");
  if (storage) await within(storage.flushAll("signal").catch(() => undefined), FLUSH_MS);
}

function putAway(): void {
  const front = BrowserWindow.getFocusedWindow();
  away = { wins: BrowserWindow.getAllWindows().filter((win) => win.isVisible()), front };
  for (const win of away.wins) win.hide();
  // Focus goes back to the app behind, as it would after a finished quit.
  if (process.platform === "darwin") app.hide();
}

export const quitApproved = () => approved;

/** The windows are put away and the quit is finishing; asking for a window now would only flash one. */
export const leaving = () => away !== null;

/** A quit that did not happen after all, like an install that failed: the windows come back and the next quit asks and flushes again. */
export function cancelQuit(): void {
  approved = false;
  if (!away) return;
  const { wins, front } = away;
  away = null;
  if (process.platform === "darwin") app.show();
  for (const win of wins) if (!win.isDestroyed()) win.showInactive();
  if (front && !front.isDestroyed()) front.focus();
}
