import type { Context } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import type { ReadResponse, SearchRequest, SearchResponse, WebSearchProvider } from "@tomradex/web-search";

export const TAVILY_API = "https://api.tavily.com";

export interface TavilySettings {
  apiKey: string;
  searchDepth: "basic" | "advanced";
}

export const TAVILY_SECTION: SettingsSection<TavilySettings> = {
  id: "tavily",
  title: "Tavily",
  description:
    "Web search and page reading for the assistant, through Tavily with your own API key from app.tavily.com. A search costs 1 credit (2 at advanced depth); reading pages costs 1 credit per 5. The key stays on this machine and no agent can read it.",
  schema: z.object({
    apiKey: z.string().default("").meta({ title: "API key", format: "password" }).describe("tvly-… — empty uses TAVILY_API_KEY from the environment"),
    searchDepth: z.enum(["basic", "advanced"]).default("basic").meta({ title: "Search depth" }).describe("advanced: more relevant excerpts per result, at twice the credits")
  }),
  defaults: { apiKey: "", searchDepth: "basic" },
  order: 17,
  scope: "machine",
  words: {
    en: { fields: { searchDepth: { options: { basic: "Basic", advanced: "Advanced" } } } },
    zh: {
      description: "通过 Tavily 为助手提供网页搜索和网页阅读，使用你在 app.tavily.com 申请的 API key。一次搜索消耗 1 积分（高级深度为 2）；每读取 5 个网页消耗 1 积分。key 只保存在这台机器上，任何智能体都读不到。",
      fields: {
        apiKey: { description: "tvly-…；留空则使用环境变量 TAVILY_API_KEY" },
        searchDepth: { title: "搜索深度", description: "高级：每条结果给出更相关的摘录，消耗的积分翻倍", options: { basic: "基础", advanced: "高级" } }
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
  if (status === 401) return "Tavily refused the API key — the user can check it in Settings → Tavily";
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
    unavailable: () => (key() ? null : "Web search has no Tavily API key yet — tell the user to add one in Settings → Tavily (keys come from https://app.tavily.com)"),

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
