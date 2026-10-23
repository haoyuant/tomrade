import { app, BrowserWindow, dialog } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/db";
import type {} from "@tomradex/storage";
import type {} from "@tomradex/analytics";
import { DESKTOP_WORDS } from "./words.js";

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
    const w = DESKTOP_WORDS(ctx.get("settings")?.locale?.());
    // A ticket session in a herdr pane is herdr's process, not this one's: it goes on, and herdr can bring it back.
    const inHerdr = sessionsInHerdr(ctx);
    const kept = inHerdr ? w(inHerdr === 1 ? "keptInHerdrOne" : "keptInHerdrMany", { n: inHerdr }) : "";
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: [w("quit"), w("cancel")],
      defaultId: 1,
      cancelId: 1,
      message: w(active.length === 1 ? "runsInProgressOne" : "runsInProgressMany", { n: active.length }),
      detail: (code ? w(code === 1 ? "runsImplementOne" : "runsImplementMany", { n: code }) : w("runsInterrupted")) + kept
    });
    if (choice === 1) return false;
  }
  // The flush can wait on a remote; the person shouldn't. From here the app looks closed.
  putAway();
  // What analytics collected goes with this quit; a few seconds is all it gets.
  await within(ctx.get("analytics")?.shutdown() ?? Promise.resolve(), 3_000);
  const storage = ctx.get("storage");
  if (!storage) return true;
  await within(storage.flushAll("quit").catch(() => undefined), FLUSH_MS);
  return settleUnsynced(ctx);
}

/** Live ticket sessions running in herdr panes, across open projects. */
function sessionsInHerdr(ctx: Context): number {
  const codeLink = ctx.get("codeLink");
  if (!codeLink) return 0;
  let n = 0;
  for (const projectId of ctx.get("db")?.openIds() ?? []) n += codeLink.sessionsOf(projectId).filter((s) => s.herdrPane && s.state !== "ended" && s.state !== "lost").length;
  return n;
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
    const w = DESKTOP_WORDS(ctx.get("settings")?.locale?.());
    // The windows are away; the question must not be.
    if (process.platform === "darwin") app.show();
    const list = left.map((p) => w("unsyncedProject", { name: p.name, count: p.count })).join("\n");
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: [w("waitForSync"), w("quitAnyway"), w("cancel")],
      defaultId: 0,
      cancelId: 2,
      message: w(total === 1 ? "unsyncedOne" : "unsyncedMany", { n: total }),
      detail: w("unsyncedDetail", { list })
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
  await within(ctx.get("analytics")?.shutdown() ?? Promise.resolve(), 3_000);
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

/** How long an approved quit may take to close every window; past it, one of them called it off. */
const CALLED_OFF_MS = 15_000;

/**
 * The quit, once approved. A window that refuses to close calls it off without
 * a word; the windows would stay put away and every later launch be ignored
 * as one arriving mid-quit, with nothing left to show the app is still there.
 */
export function finishQuit(): void {
  const done = () => clearTimeout(timer);
  const timer = setTimeout(() => {
    app.off("will-quit", done);
    cancelQuit();
  }, CALLED_OFF_MS);
  app.once("will-quit", done);
  app.quit();
}

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
