import type { ReadResponse, SearchHit, SearchRequest, WebSearchProvider } from "@tomradex/web-search";

const DEEPSEEK = /^https?:\/\/api\.deepseek\.com(\/|:|$)/i;
/** DeepSeek takes a query of at most 128 characters. */
const QUERY_MAX = 128;
/** The most one search returns; asking for them all costs the same, so results to be filtered here are asked for in full. */
const COUNT_MAX = 50;

export interface DeepSeekKey {
  key: string;
  origin: string;
}

export interface ProfileLike {
  baseURL?: string;
  apiKey?: string;
}

/** The key of the first DeepSeek model profile that has one. Nothing for the person to set up. */
export function deepseekKey(profiles: ProfileLike[]): DeepSeekKey | null {
  for (const profile of profiles) {
    const key = profile.apiKey?.trim();
    if (key && profile.baseURL && DEEPSEEK.test(profile.baseURL)) return { key, origin: new URL(profile.baseURL).origin };
  }
  return null;
}

interface DeepSeekResult {
  title?: string;
  url: string;
  snippet?: string;
  summary?: string;
  date?: string | null;
}

interface DeepSeekPage {
  title?: string;
  content?: string;
}

const SPAN_DAYS: Record<NonNullable<SearchRequest["timeRange"]>, number> = { day: 1, week: 7, month: 31, year: 366 };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain.toLowerCase()}`);

function failure(status: number, body: string): string {
  if (status === 401) return "DeepSeek refused the API key — the user can check the DeepSeek model's key in Settings → Models";
  if (status === 402) return "The DeepSeek account has run out of balance — the user can top it up at platform.deepseek.com";
  if (status === 403) return "DeepSeek's security policy refused to read this page";
  if (status === 404) return "DeepSeek found no readable content on this page";
  if (status === 429) return "DeepSeek is rate-limiting this account (5 searches and 5 page reads a second); try again in a moment";
  let message = body.slice(0, 300) || "no details";
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message;
  } catch {}
  return `DeepSeek answered ${status}: ${message}`;
}

export interface DeepSeekOptions {
  /** Its id among the web search providers. */
  id: string;
  key(): DeepSeekKey | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function deepseekProvider({ id, key, fetch: send = fetch, now = () => new Date() }: DeepSeekOptions): WebSearchProvider {
  async function call<T>(tool: "search" | "fetch", body: object, signal: AbortSignal): Promise<T> {
    const found = key();
    if (!found) throw new Error("No DeepSeek API key");
    let response: Response;
    try {
      response = await send(`${found.origin}/v1/tools/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${found.key}` },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Could not reach ${new URL(found.origin).host}: ${error instanceof Error ? (error.cause as Error | undefined)?.message ?? error.message : String(error)} — check this machine's network or proxy`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(failure(response.status, text));
    return JSON.parse(text) as T;
  }

  return {
    id,
    title: "DeepSeek",
    // A DeepSeek key lives on its model profile.
    settings: "assistant",
    unavailable: () => (key() ? null : "Web search through DeepSeek needs a DeepSeek model with an API key — the user can add one in Settings → Models (keys come from platform.deepseek.com)"),

    async search(request, signal) {
      const include = request.includeDomains ?? [];
      const exclude = request.excludeDomains ?? [];
      const since = request.timeRange ? now().getTime() - SPAN_DAYS[request.timeRange] * 86_400_000 : null;
      // One site is DeepSeek's own `site:` operator; anything else is filtered here from a full page of results.
      const operator = include.length === 1 ? ` site:${include[0]}` : "";
      const filtered = include.length > 1 || exclude.length > 0 || since !== null;
      const query = request.query.slice(0, QUERY_MAX - operator.length).trim() + operator;
      const data = await call<{ results?: DeepSeekResult[] }>("search", { query, count: filtered ? COUNT_MAX : request.maxResults }, signal);
      const hits: SearchHit[] = [];
      for (const r of data.results ?? []) {
        const host = hostOf(r.url);
        if (include.length && !include.some((d) => within(host, d))) continue;
        if (exclude.some((d) => within(host, d))) continue;
        // A result without a date cannot be shown to be recent.
        if (since !== null && !(r.date && Date.parse(r.date) >= since)) continue;
        hits.push({ title: r.title ?? "", url: r.url, content: r.summary || r.snippet || "", ...(r.date && { published: r.date }) });
      }
      return { results: hits.slice(0, request.maxResults) };
    },

    // One page per request: DeepSeek's fetch takes a single URL.
    async read({ urls }, signal) {
      const out: ReadResponse = { pages: [], failed: [] };
      const settled = await Promise.allSettled(urls.map((url) => call<DeepSeekPage>("fetch", { url }, signal)));
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") out.pages.push({ url: urls[i]!, content: result.value.content ?? "" });
        else out.failed.push({ url: urls[i]!, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      });
      return out;
    }
  };
}
