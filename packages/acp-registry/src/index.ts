import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { contract } from "@tomradex/contracts";
import type {} from "@tomradex/engine-acp";
import type {} from "@tomradex/ipc";
import type { SettingsSection } from "@tomradex/settings";
import { fetchRegistry, readCache, writeCache, REGISTRY_MAX_AGE_MS, REGISTRY_URL, type RegistryAgent } from "./registry.js";
import { addedOf, AddedAgent, specOf } from "./spec.js";

declare module "cordis" {
  interface Context {
    acpRegistry: AcpRegistry;
  }
}

/** One registry entry as the add-agent view draws it. */
export interface RegistryAgentView {
  id: string;
  name: string;
  description: string;
  version: string;
  license?: string;
  added: boolean;
}

export interface RegistryListing {
  /** ok: fresh enough; stale: only an old cache answered; unavailable: nothing to show. */
  state: "ok" | "stale" | "unavailable";
  fetchedAt?: number;
  agents: RegistryAgentView[];
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The registry's offerable agents; `fresh` asks the CDN past the cache. */
    "acpRegistry.list": (fresh?: boolean) => RegistryListing;
    /** Adds the entry as a local agent; false when the registry does not offer it. */
    "acpRegistry.add": (id: string) => boolean;
    "acpRegistry.remove": (id: string) => boolean;
  }
}

const SECTION: SettingsSection<{ added: AddedAgent[] }> = {
  id: "acpRegistry",
  title: "ACP registry agents",
  description: "Agents added from the ACP registry; each runs over ACP through npx, like an agent a plugin declares.",
  schema: z.object({ added: z.array(AddedAgent).default([]) }),
  defaults: { added: [] },
  order: 40
};

const sameAgent = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export const AcpRegistryConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    url: z.string().default(REGISTRY_URL)
  })
);
export type AcpRegistryConfig = z.infer<typeof AcpRegistryConfig>;

/**
 * Agents from the ACP registry (Zed + JetBrains's curated catalog): the person
 * adds one in Settings, and it becomes a local-agent declaration like a
 * plugin's — found through npx, installed with npm, run over ACP, set up by
 * the same chain. The added manifests live in settings, so launches need no
 * registry; the listing is cached and survives offline.
 */
export class AcpRegistry extends Service {
  static provide = "acpRegistry";
  static inject = ["settings", "localAgents"];
  static Config = AcpRegistryConfig;

  /** Replaceable, so tests never reach the CDN. */
  fetcher: typeof fetch = fetch;
  private cache: { fetchedAt: number; agents: RegistryAgent[] } | null = null;
  private cacheFile: string | null = null;
  private registered = new Map<string, () => void>();

  constructor(
    ctx: Context,
    public readonly config: AcpRegistryConfig
  ) {
    super(ctx, "acpRegistry");
  }

  [Service.init]() {
    this.ctx.settings.register(SECTION);
    this.ctx.inject(["db"], (ctx) => {
      const dir = contract(ctx, "db")?.config.dir;
      if (!dir || dir === ":memory:") return;
      this.cacheFile = path.join(dir, "acp-registry.json");
      this.cache ??= readCache(this.cacheFile);
    });
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("acpRegistry.list", (fresh) => ctx.acpRegistry.list(fresh));
      ctx.ipc.handle("acpRegistry.add", (id) => ctx.acpRegistry.add(id));
      ctx.ipc.handle("acpRegistry.remove", (id) => ctx.acpRegistry.remove(id));
    });
    this.sync();
    this.ctx.on("settings/changed", () => this.sync());
    this.ctx.effect(() => () => {
      for (const dispose of this.registered.values()) dispose();
      this.registered.clear();
    });
  }

  private added(): AddedAgent[] {
    return (this.ctx.settings.get().acpRegistry as { added?: AddedAgent[] } | undefined)?.added ?? SECTION.defaults.added;
  }

  /** The registrations follow the settings: an entry added registers, one removed goes. */
  private sync(): void {
    const want = new Map(this.added().map((agent) => [agent.id, agent]));
    for (const [id, dispose] of this.registered) {
      if (want.has(id)) continue;
      dispose();
      this.registered.delete(id);
    }
    for (const [id, agent] of want) {
      if (!this.registered.has(id)) this.registered.set(id, this.ctx.localAgents.register(specOf(agent)));
    }
  }

  async list(fresh = false): Promise<RegistryListing> {
    const now = Date.now();
    if (fresh || !this.cache || now - this.cache.fetchedAt > REGISTRY_MAX_AGE_MS) {
      const got = await fetchRegistry(this.config.url, this.fetcher);
      if (got) {
        this.cache = { fetchedAt: now, agents: got.agents };
        if (this.cacheFile) writeCache(this.cacheFile, now, got.raw);
      }
    }
    if (!this.cache) return { state: "unavailable", agents: [] };
    const added = new Set(this.added().map((agent) => agent.id));
    // An agent Tomrade already has — built in, or a plugin's — is not offered twice.
    const taken = new Set(
      (this.ctx.get("agent") ? this.ctx.agent.allEngines() : []).filter((e) => !e.id.startsWith("registry:")).flatMap((e) => [sameAgent(e.id), sameAgent(e.title)])
    );
    const agents = this.cache.agents
      .filter((agent) => added.has(agent.id) || (!taken.has(sameAgent(agent.id)) && !taken.has(sameAgent(agent.name))))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        ...(agent.license ? { license: agent.license } : {}),
        added: added.has(agent.id)
      }));
    return { state: now - this.cache.fetchedAt > REGISTRY_MAX_AGE_MS ? "stale" : "ok", fetchedAt: this.cache.fetchedAt, agents };
  }

  add(id: string): boolean {
    const entry = this.cache?.agents.find((agent) => agent.id === id);
    if (!entry?.distribution.npx) return false;
    const all = this.ctx.settings.get();
    this.ctx.settings.set({ ...all, acpRegistry: { added: [...this.added().filter((agent) => agent.id !== id), addedOf(entry)] } });
    return true;
  }

  remove(id: string): boolean {
    const kept = this.added().filter((agent) => agent.id !== id);
    if (kept.length === this.added().length) return false;
    const all = this.ctx.settings.get();
    this.ctx.settings.set({ ...all, acpRegistry: { added: kept } });
    return true;
  }
}

export default AcpRegistry;
export { fetchRegistry, parseRegistry, readCache, writeCache, REGISTRY_MAX_AGE_MS, REGISTRY_URL, RegistryAgent } from "./registry.js";
export { addedOf, AddedAgent, specOf } from "./spec.js";
