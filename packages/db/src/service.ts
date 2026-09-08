import Database from "better-sqlite3";
import { Context, Service } from "cordis";
import { z } from "zod";
import { CORE_INDEXES_SQL, CORE_TABLES_SQL } from "./schema.js";
import { migrateCore } from "./migrate.js";
import type { Sqlite, Statement } from "./sqlite.js";
import type {} from "@tomrade/ipc";

declare module "cordis" {
  interface Context {
    db: Db;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "db.path": () => string;
  }
}

export interface Migration {
  version: number;
  up: string | ((db: Sqlite) => void);
}

export const DbConfig = z.object({
  path: z.string().default(":memory:")
});

export type DbConfig = z.infer<typeof DbConfig>;

const CREATE_TABLE = /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?(\w+)/gi;

export class Db extends Service {
  static provide = "db";
  static Config = DbConfig;

  handle!: Sqlite;

  constructor(
    ctx: Context,
    public readonly config: DbConfig
  ) {
    super(ctx, "db");
  }

  [Service.init](): () => void {
    this.handle = new Database(this.config.path);
    this.handle.pragma("journal_mode = WAL");
    this.handle.exec(CORE_TABLES_SQL);
    migrateCore(this.handle);
    this.handle.exec(CORE_INDEXES_SQL);
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("db.path", () => ctx.db.path);
    });
    return () => {
      this.handle.close();
    };
  }

  get path(): string {
    return this.config.path;
  }

  prepare(sql: string): Statement {
    return this.handle.prepare(sql);
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  pragma(source: string): unknown {
    return this.handle.pragma(source, { simple: true });
  }

  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn)();
  }

  /**
   * Run a plugin's pending migrations. Each namespace keeps its own version
   * counter, and SQL migrations may only touch tables named `plugin_<namespace>_*`.
   */
  migrate(namespace: string, migrations: Migration[]): number {
    const prefix = `plugin_${namespace}_`;
    const current = (this.handle.prepare("SELECT version FROM plugin_migrations WHERE namespace = ?").get(namespace) as { version: number } | undefined)?.version ?? 0;
    let version = current;
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= version) continue;
      if (typeof m.up === "string") {
        for (const match of m.up.matchAll(CREATE_TABLE)) {
          if (!match[1].startsWith(prefix)) throw new Error(`migration ${namespace}@${m.version} touches "${match[1]}"; plugin tables must be named ${prefix}*`);
        }
      }
      this.handle.transaction(() => {
        if (typeof m.up === "string") this.handle.exec(m.up);
        else m.up(this.handle);
        this.handle
          .prepare("INSERT INTO plugin_migrations (namespace, version) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version")
          .run(namespace, m.version);
      })();
      version = m.version;
    }
    return version;
  }
}
