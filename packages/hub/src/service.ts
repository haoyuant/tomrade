import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/ipc";
import { Catalog, RemoteRef, type CatalogDamage } from "./catalog.js";
import type { HubReader } from "@tomradex/contracts";
import { readJsonOr, writeJsonAtomic } from "@tomradex/contracts";

declare module "cordis" {
  interface Context {
    hub: Hub;
  }
  interface Events {
    /** The Hub folder was chosen or moved. */
    "hub/configured"(dir: string): void;
  }
}

export interface HubInfo {
  deviceId: string;
  /** Legacy local-Hub root. Cloud builds use it only as a managed-files root. */
  dir: string | null;
  /** Default location for durable project folders on this machine. */
  projectsDir: string;
  defaultDir: string;
  configured: boolean;
  cloudEnabled: boolean;
  /** `catalog.json` did not read whole: why, and the copy kept. Nothing is saved over it until `hub.overwriteCatalog`. */
  catalogProblem: CatalogDamage | null;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "hub.info": () => HubInfo;
    /** First run, or a move: name the Hub folder. Created if absent. */
    "hub.configure": (dir: string) => HubInfo;
    /** The person has read why `catalog.json` failed to read: what was salvaged is written over it. */
    "hub.overwriteCatalog": () => HubInfo;
  }
  interface Broadcasts {
    "hub.changed": () => void;
  }
}

export const HubConfig = z.object({
  /** `hub.json`: the Hub folder and its remote binding. Machine-local. */
  stateFile: z.string().optional(),
  /** `catalog.json`: the projects and repository checkouts this machine knows. Machine-local. */
  catalogFile: z.string().optional(),
  /** `device.json`: this machine's id, stamped on every oplog row. */
  deviceFile: z.string().optional(),
  /** Offered on first run. Not ~/Documents: macOS may hand that folder to iCloud and evict files. */
  defaultDir: z.string().optional(),
  /** Tests: keep everything in RAM and treat the Hub as configured at `defaultDir`. */
  memory: z.boolean().default(false)
});
export type HubConfig = z.infer<typeof HubConfig>;

const HubState = z.object({
  v: z.literal(1).default(1),
  dir: z.string().nullable().default(null),
  remote: RemoteRef.nullable().default(null),
  lastPublishedDigest: z.string().nullable().default(null),
  lastSyncAt: z.number().nullable().default(null)
});
type HubState = z.infer<typeof HubState>;

/**
 * This machine, as far as Tomrade is concerned: a stable device id, the Hub
 * folder where the user's own files live, and the catalog of what is here.
 * Nothing in this service is ever synced; all of it can be rebuilt.
 */
export class Hub extends Service implements HubReader {
  static provide = "hub";
  static Config = HubConfig;

  deviceId!: string;
  cloudEnabled = false;
  catalog!: Catalog;
  private state: HubState = { v: 1, dir: null, remote: null, lastPublishedDigest: null, lastSyncAt: null };
  private readonly home: Context;

  constructor(
    ctx: Context,
    public readonly config: HubConfig
  ) {
    super(ctx, "hub");
    this.home = ctx;
  }

  [Service.init]() {
    this.deviceId = this.loadDevice();
    this.catalog = new Catalog(this.config.memory ? null : (this.config.catalogFile ?? null));
    if (this.config.memory) {
      this.state.dir = this.config.defaultDir ?? null;
    } else if (this.config.stateFile) {
      const parsed = HubState.safeParse(readJsonOr<unknown>(this.config.stateFile, undefined) ?? {});
      if (parsed.success) this.state = parsed.data;
    }
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("hub.info", () => ctx.hub.info());
      ctx.ipc.handle("hub.configure", (dir) => ctx.hub.configure(dir));
      ctx.ipc.handle("hub.overwriteCatalog", () => ctx.hub.overwriteCatalog());
    });
  }

  get dir(): string | null {
    return this.state.dir ?? (this.cloudEnabled ? this.defaultDir : null);
  }

  get projectsDir(): string {
    return path.join(this.dir ?? this.defaultDir, "projects");
  }

  get defaultDir(): string {
    return this.config.defaultDir ?? path.join(os.homedir(), "Tomrade");
  }

  get configured(): boolean {
    return this.cloudEnabled || this.state.dir !== null;
  }

  get remote(): HubState["remote"] {
    return this.state.remote;
  }

  info(): HubInfo {
    return { deviceId: this.deviceId, dir: this.dir, projectsDir: this.projectsDir, defaultDir: this.defaultDir, configured: this.configured, cloudEnabled: this.cloudEnabled, catalogProblem: this.catalog.corrupt };
  }

  overwriteCatalog(): HubInfo {
    this.catalog.confirmOverwrite();
    this.home.get("ipc")?.send("hub.changed");
    return this.info();
  }

  /** Cloud owns Hub metadata; this only enables local placement defaults. */
  enableCloud(): () => void {
    this.cloudEnabled = true;
    this.home.get("ipc")?.send("hub.changed");
    return () => {
      this.cloudEnabled = false;
      this.home.get("ipc")?.send("hub.changed");
    };
  }

  /** Choose (or move to) the Hub folder. The folder is created; nothing is moved into it here. */
  configure(dir: string): HubInfo {
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    this.state = { ...this.state, dir: resolved };
    this.persist();
    this.home.emit("hub/configured", resolved);
    this.home.get("ipc")?.send("hub.changed");
    return this.info();
  }

  patchState(patch: Partial<Omit<HubState, "v" | "dir">>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
  }

  private persist(): void {
    if (this.config.memory || !this.config.stateFile) return;
    writeJsonAtomic(this.config.stateFile, this.state);
  }

  private loadDevice(): string {
    if (this.config.memory || !this.config.deviceFile) return this.config.memory ? "test-device" : randomBytes(6).toString("hex");
    const existing = readJsonOr<{ id?: unknown } | undefined>(this.config.deviceFile, undefined);
    if (existing && typeof existing.id === "string" && existing.id) return existing.id;
    const id = randomBytes(6).toString("hex");
    writeJsonAtomic(this.config.deviceFile, { id });
    return id;
  }
}
