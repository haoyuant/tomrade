import type { Context } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import type { ReadResponse, SearchRequest, SearchResponse, WebSearchProvider } from "@tomradex/web-search";
import { TAVILY_WORDS } from "./words.js";

export const TAVILY_API = "https://api.tavily.com";

export interface TavilySettings {
  apiKey: string;
  searchDepth: "basic" | "advanced";
}

const en = TAVILY_WORDS("en");
const zh = TAVILY_WORDS("zh");

export const TAVILY_SECTION: SettingsSection<TavilySettings> = {
  id: "tavily",
  title: en("title"),
  description: en("description"),
  schema: z.object({
    apiKey: z.string().default("").meta({ title: en("apiKeyTitle"), format: "password" }).describe(en("apiKeyDescription")),
    searchDepth: z.enum(["basic", "advanced"]).default("basic").meta({ title: en("searchDepthTitle") }).describe(en("searchDepthDescription"))
  }),
  defaults: { apiKey: "", searchDepth: "basic" },
  order: 17,
  scope: "machine",
  words: {
    en: { fields: { searchDepth: { options: { basic: en("searchDepthBasic"), advanced: en("searchDepthAdvanced") } } } },
    zh: {
      title: zh("title"),
      description: zh("description"),
      fields: {
        apiKey: { title: zh("apiKeyTitle"), description: zh("apiKeyDescription") },
        searchDepth: { title: zh("searchDepthTitle"), description: zh("searchDepthDescription"), options: { basic: zh("searchDepthBasic"), advanced: zh("searchDepthAdvanced") } }
      }
    }
  }
};

interface TavilySearch {
  results?: { title?: string; url: string; content?: string; published_date?: string | null }[];
}

interface TavilyExtract {
  results?: { url: string; raw_content?: string | null }[];
  failed_results?: { url: string; error?: string }[];
}

/** Tavily's error body is `{ detail: { error } }`, or a list of field problems for a 422. */
function detailOf(body: string): string {
  try {
    const { detail } = JSON.parse(body) as { detail?: unknown };
    if (Array.isArray(detail)) return detail.map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).join(".")}: ${d.msg}`).join("; ");
    if (detail && typeof detail === "object" && "error" in detail) return String(detail.error);
    if (typeof detail === "string") return detail;
  } catch {}
  return body.slice(0, 300) || "no details";
}

function failure(status: number, body: string, retryAfter: string | null): string {
  if (status === 401) return "Tavily refused the API key — the user can check it in Settings → Web search";
  if (status === 429) return `Tavily is rate-limiting this key${retryAfter ? `; try again in ${retryAfter} s` : ""}`;
  if (status === 432 || status === 433) return `This Tavily key has reached its credit limit: ${detailOf(body)}`;
  return `Tavily answered ${status}: ${detailOf(body)}`;
}

export interface TavilyOptions {
  settings(): TavilySettings;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function tavilyProvider({ settings, env = process.env, fetch: send = fetch }: TavilyOptions): WebSearchProvider {
  const key = () => settings().apiKey.trim() || env.TAVILY_API_KEY?.trim() || "";

  async function call<T>(endpoint: "search" | "extract", body: object, signal: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await send(`${TAVILY_API}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Could not reach ${new URL(TAVILY_API).host}: ${error instanceof Error ? (error.cause as Error | undefined)?.message ?? error.message : String(error)} — check this machine's network or proxy`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(failure(response.status, text, response.headers.get("retry-after")));
    return JSON.parse(text) as T;
  }

  return {
    id: "tavily",
    title: "Tavily",
    settings: TAVILY_SECTION.id,
    unavailable: () => (key() ? null : "Web search has no Tavily API key yet — tell the user to add one in Settings → Web search (keys come from https://app.tavily.com)"),

    async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
      const data = await call<TavilySearch>(
        "search",
        {
          query: request.query,
          max_results: request.maxResults,
          topic: request.topic,
          search_depth: settings().searchDepth,
          ...(request.timeRange && { time_range: request.timeRange }),
          ...(request.includeDomains?.length && { include_domains: request.includeDomains }),
          ...(request.excludeDomains?.length && { exclude_domains: request.excludeDomains })
        },
        signal
      );
      return {
        results: (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url, content: r.content ?? "", ...(r.published_date && { published: r.published_date }) }))
      };
    },

    async read({ urls, query }, signal): Promise<ReadResponse> {
      const data = await call<TavilyExtract>("extract", { urls, format: "markdown", ...(query && { query }) }, signal);
      return {
        pages: (data.results ?? []).map((r) => ({ url: r.url, content: r.raw_content ?? "" })),
        failed: (data.failed_results ?? []).map((r) => ({ url: r.url, error: r.error ?? "not readable" }))
      };
    }
  };
}

export default {
  name: "web-search-tavily",
  inject: ["webSearch", "settings"],
  apply(ctx: Context) {
    ctx.settings.register(TAVILY_SECTION);
    const settings = () => ({ ...TAVILY_SECTION.defaults, ...(ctx.settings.get().tavily as Partial<TavilySettings> | undefined) });
    ctx.webSearch.register(tavilyProvider({ settings }));
  }
};
