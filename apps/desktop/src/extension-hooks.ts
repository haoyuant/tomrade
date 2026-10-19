import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Module resolution for code that lives outside the app. An extension imports
 * `cordis`, `@tomradex/plugin-sdk` and `zod` but ships none of them: it must
 * get the host's own copies, or it would build its own world beside ours.
 * A full-mode plugin, which runs with the whole Context, also gets the app's
 * own `@tomradex/*` packages, as a dsh plugin gets dsh's through its peers.
 * Runs on Node's loader thread.
 */
interface HookData {
  map: Record<string, string>;
  /** file: URL prefixes of the app itself, whose imports resolve as usual. */
  inside: string[];
  /** A file of the app's own, from which a full-mode plugin's `@tomradex/*` imports resolve. */
  anchor: string;
}

let data: HookData = { map: {}, inside: [], anchor: "" };

export async function initialize(given: HookData): Promise<void> {
  data = given;
}

type Next = (specifier: string, context: { parentURL?: string }) => Promise<{ url: string }>;

/** Whether a file belongs to a package whose manifest says full mode; the nearest `tomrade-plugin.json` decides, read once per folder. */
const fullByDir = new Map<string, boolean>();
function inFullPlugin(file: string): boolean {
  const seen: string[] = [];
  let dir = path.dirname(file);
  for (;;) {
    const known = fullByDir.get(dir);
    if (known !== undefined) return remember(seen, known);
    seen.push(dir);
    const manifest = path.join(dir, "tomrade-plugin.json");
    if (fs.existsSync(manifest)) {
      let full = false;
      try {
        full = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { context?: unknown }).context === "full";
      } catch {
        // an unreadable manifest is refused by the store before its code is imported
      }
      return remember(seen, full);
    }
    const up = path.dirname(dir);
    if (up === dir) return remember(seen, false);
    dir = up;
  }
}
function remember(dirs: string[], full: boolean): boolean {
  for (const dir of dirs) fullByDir.set(dir, full);
  return full;
}

export async function resolve(specifier: string, context: { parentURL?: string }, next: Next) {
  const parent = context.parentURL;
  if (!parent?.startsWith("file:") || data.inside.some((prefix) => parent.startsWith(prefix))) return next(specifier, context);
  const url = data.map[specifier];
  if (url) return { url, shortCircuit: true };
  if (specifier.startsWith("@tomradex/") && data.anchor && inFullPlugin(fileURLToPath(parent))) return next(specifier, { ...context, parentURL: data.anchor });
  return next(specifier, context);
}
