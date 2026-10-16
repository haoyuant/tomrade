import path from "node:path";
import { app } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/files";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/projects";
import { showMainWindow, whenLoaded } from "./main-window.js";

/**
 * `tomrade://` links, as IM replies carry them: `item/<project>/<key>`,
 * `thread/<project>/<thread>` and `file/<project>/<fileId>`. They open the
 * object in the main window, which comes forward (or opens) for it.
 */
export interface DeepLink { kind: "item" | "thread" | "file"; projectId: string; ref: string }

export const SCHEME = "tomrade";

export function parseDeepLink(url: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:`) return null;
  const kind = u.hostname;
  const parts = u.pathname.split("/").filter(Boolean);
  if ((kind !== "item" && kind !== "thread" && kind !== "file") || parts.length !== 2) return null;
  try {
    return { kind, projectId: decodeURIComponent(parts[0]!), ref: decodeURIComponent(parts[1]!) };
  } catch {
    return null;
  }
}

/** What the renderer is asked to show. */
export interface OpenTarget { projectId: string; itemId?: string; threadId?: string; path?: string }

declare module "@tomradex/ipc" {
  interface Broadcasts {
    "app.open": (target: OpenTarget) => void;
  }
}

let handler: ((url: string) => void) | null = null;
const waiting: string[] = [];

/** From main.ts: a link the system handed over, held until the app has booted far enough to follow it. */
export function deliverDeepLink(url: string): void {
  if (!url.startsWith(`${SCHEME}://`)) return;
  if (handler) handler(url);
  else waiting.push(url);
}

/** Makes this app the one the system starts for `tomrade:` links; a checkout names its entry script. */
export function registerScheme(): void {
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SCHEME);
}

export const deepLinks = {
  name: "deep-links",
  inject: ["ipc", "projects", "items"],
  apply(ctx: Context) {
    const resolve = async (link: DeepLink): Promise<OpenTarget | null> => {
      if (!ctx.projects.get(link.projectId)) return null;
      if (link.kind === "thread") return { projectId: link.projectId, threadId: link.ref };
      if (link.kind === "item") {
        const item = ctx.items.getByKey(link.projectId, link.ref) ?? ctx.items.get(link.projectId, link.ref);
        return item ? { projectId: link.projectId, itemId: item.id } : null;
      }
      const files = ctx.get("files");
      const found = files ? await files.locate(link.projectId, link.ref) : null;
      return found ? { projectId: link.projectId, path: found } : null;
    };
    const follow = (url: string) => {
      const link = parseDeepLink(url);
      if (!link) return;
      void resolve(link).then((target) => {
        const win = showMainWindow();
        // A link to something that is gone still brings Tomrade forward.
        if (!target) return;
        if (win) whenLoaded(win, () => ctx.ipc.send("app.open", target));
        else ctx.ipc.send("app.open", target);
      }).catch((e: unknown) => ctx.logger.warn(`couldn't open ${url}: ${(e as Error).message}`));
    };
    ctx.effect(() => {
      handler = follow;
      for (const url of waiting.splice(0)) follow(url);
      return () => { if (handler === follow) handler = null; };
    }, "deep links");
  }
};

export default deepLinks;
