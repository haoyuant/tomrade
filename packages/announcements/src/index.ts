import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import { satisfies } from "@tomradex/plugin-sdk";
import type {} from "@tomradex/settings";
import { ANNOUNCEMENT_WORDS } from "./words.js";

export const name = "announcements";
export const inject = ["ipc"];

export interface Announcement {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
  level: "info" | "important";
  /** Null is every language. */
  locale: "en" | "zh" | null;
  startsAt: string;
  /** Shown on this machine already. */
  seen: boolean;
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The current announcements for this version, newest first. */
    "announcements.list": () => Announcement[];
    "announcements.markSeen": (id: string) => Announcement[];
  }
  interface Broadcasts {
    "announcements.changed": (list: Announcement[]) => void;
  }
}

/** The account client `@tomradex/hub-cloud` provides, read structurally; RLS lets it read signed in or not. */
export interface Backend {
  client: {
    from(table: string): {
      select(columns: string): {
        order(column: string, opts: { ascending: boolean }): {
          limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
        };
      };
    };
  };
}

interface Row {
  id: string;
  title: string;
  body: string;
  level: string;
  locale: string | null;
  versions: string | null;
  starts_at: string;
}

export interface Config {
  /** Which announcements this machine has shown. */
  file: string;
  version: string;
  everyMs?: number;
}

const COLUMNS = "id, title, body, level, locale, versions, starts_at";
const KEEP_SEEN = 500;

export function visible(rows: Row[], version: string, seen: ReadonlySet<string>): Announcement[] {
  return rows
    .filter((r) => !r.versions || satisfies(version, r.versions))
    .map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      level: r.level === "important" ? "important" : "info",
      locale: r.locale === "en" || r.locale === "zh" ? r.locale : null,
      startsAt: r.starts_at,
      seen: seen.has(r.id)
    }));
}

function readSeen(file: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { seen?: unknown };
    return Array.isArray(raw.seen) ? raw.seen.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function apply(ctx: Context, config: Config) {
  const seen = readSeen(config.file);
  let rows: Row[] = [];
  /** Until the feed has answered once, asking for the list asks it. */
  let loaded = false;
  const list = () => visible(rows, config.version, new Set(seen));

  const fetchNow = async () => {
    const hub = ctx.get("cloudHub") as Backend | undefined;
    if (!hub) return;
    const { data, error } = await hub.client.from("tomrade_announcements").select(COLUMNS).order("starts_at", { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    const next = (data ?? []) as Row[];
    const changed = JSON.stringify(next) !== JSON.stringify(rows);
    rows = next;
    loaded = true;
    if (changed) ctx.ipc.send("announcements.changed", list());
  };
  // Offline or no Supabase: no announcements this time, nothing else held up.
  const refresh = () => fetchNow().catch((err) => ctx.logger.warn(`announcements: ${err instanceof Error ? err.message : String(err)}`));

  ctx.ipc.handle("announcements.list", async () => {
    if (!loaded) await refresh();
    return list();
  });
  ctx.ipc.handle("announcements.markSeen", (id) => {
    if (!seen.includes(id)) {
      seen.push(id);
      seen.splice(0, Math.max(0, seen.length - KEEP_SEEN));
      try {
        fs.mkdirSync(path.dirname(config.file), { recursive: true });
        fs.writeFileSync(config.file, JSON.stringify({ seen }));
      } catch (err) {
        ctx.logger.warn(`announcements: could not keep what was seen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return list();
  });

  // Read again whenever wanted, from the palette: the renderer's announcements surface.
  ctx.inject(["contributions"], (ctx) => {
    const words = () => ANNOUNCEMENT_WORDS((ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
    ctx.contributions.command({ id: "announcements.open", title: () => words()("command"), group: () => words()("group"), run: () => ({ opens: "announcements" }) });
  });

  ctx.effect(() => {
    const timer = setInterval(refresh, config.everyMs ?? 60 * 60_000);
    return () => clearInterval(timer);
  });
}
