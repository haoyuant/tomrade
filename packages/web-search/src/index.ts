import { Context, Service } from "cordis";
import type {} from "@tomradex/tools";
import { registerTools } from "./tools.js";

export { formatPages, formatResults } from "./tools.js";

export type SearchTopic = "general" | "news";
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchRequest {
  query: string;
  maxResults: number;
  topic: SearchTopic;
  timeRange?: TimeRange;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchHit {
  title: string;
  url: string;
  /** An excerpt, not the page. */
  content: string;
  published?: string;
}

export interface SearchResponse {
  results: SearchHit[];
}

export interface ReadRequest {
  urls: string[];
  /** Keep only the passages relevant to this. */
  query?: string;
}

export interface ReadResponse {
  pages: { url: string; content: string }[];
  failed: { url: string; error: string }[];
}

/** One search backend. The first registered provider that is available answers. */
export interface WebSearchProvider {
  id: string;
  title: string;
  /** Why it cannot answer yet — no API key, say — or null when it can. The agent reads this as the tool's error. */
  unavailable(): string | null;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
  /** Pages as Markdown. A provider without it leaves `web_fetch` to another. */
  read?(request: ReadRequest, signal: AbortSignal): Promise<ReadResponse>;
  /** The settings pane where the person sets it up. */
  settings?: string;
}

/** Why no provider can search, and where the person fixes it. */
export interface Unavailable {
  reason: string;
  settings?: string;
}

declare module "cordis" {
  interface Context {
    webSearch: WebSearch;
  }
  interface Events {
    "webSearch/registered"(id: string): void;
    "webSearch/unregistered"(id: string): void;
  }
}

export const SEARCH_TIMEOUT_MS = 30_000;
export const READ_TIMEOUT_MS = 60_000;

export class WebSearch extends Service {
  static provide = "webSearch";

  private readonly home: Context;
  private readonly registry = new Map<string, WebSearchProvider>();

  constructor(ctx: Context) {
    super(ctx, "webSearch");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.inject(["tools"], (ctx) => registerTools(ctx, this));
  }

  /** Reversible: the provider goes with the plugin that registered it, and the tools with the last one. */
  register(provider: WebSearchProvider): () => void {
    if (this.registry.has(provider.id)) throw new Error(`web search provider "${provider.id}" is already registered`);
    return this.ctx.effect(() => {
      this.registry.set(provider.id, provider);
      this.home.emit("webSearch/registered", provider.id);
      return () => {
        this.registry.delete(provider.id);
        this.home.emit("webSearch/unregistered", provider.id);
      };
    }, `webSearch.register(${provider.id})`);
  }

  providers(): WebSearchProvider[] {
    return [...this.registry.values()];
  }

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const provider = this.pick(() => true);
    return bounded(`${provider.title} search`, SEARCH_TIMEOUT_MS, signal, (s) => provider.search(request, s));
  }

  read(request: ReadRequest, signal?: AbortSignal): Promise<ReadResponse> {
    const provider = this.pick((p) => !!p.read);
    return bounded(`${provider.title} page reading`, READ_TIMEOUT_MS, signal, (s) => provider.read!(request, s));
  }

  /** Why nobody can search right now; null when a provider can. */
  unavailable(): Unavailable | null {
    return this.missing(() => true);
  }

  /** The first available provider that can do it, else the first one's reason for not being available. */
  private pick(can: (p: WebSearchProvider) => boolean): WebSearchProvider {
    const missing = this.missing(can);
    if (missing) throw new Error(missing.reason);
    return this.providers().filter(can).find((p) => !p.unavailable())!;
  }

  private missing(can: (p: WebSearchProvider) => boolean): Unavailable | null {
    const able = this.providers().filter(can);
    if (able.some((p) => !p.unavailable())) return null;
    if (!able.length) return { reason: "No web search provider is switched on — the user can turn one on in Settings → Plugins", settings: "plugins" };
    return { reason: able[0].unavailable()!, ...(able[0].settings ? { settings: able[0].settings } : {}) };
  }
}

/** The caller's cancellation plus our own deadline; a deadline that passes says so instead of "aborted". */
async function bounded<T>(what: string, ms: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  try {
    return await work(signal ? AbortSignal.any([signal, deadline]) : deadline);
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new Error(`${what} took longer than ${ms / 1000} s and was stopped`);
    throw error;
  }
}

export default WebSearch;
