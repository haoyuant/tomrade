import type { ReadResponse, SearchRequest, WebSearchProvider } from "@tomradex/web-search";

/** Moonshot's API hosts; a key belongs to one of them, and both serve the search tools. */
const MOONSHOT = /^https?:\/\/api\.moonshot\.(cn|ai)(\/|:|$)/i;
const PRO_SITES_MAX = 5;
const TIMEOUT_SECONDS = 30;

export interface KimiKey {
  key: string;
  origin: string;
}

export interface ProfileLike {
  baseURL?: string;
  apiKey?: string;
}

/** The key of the first Kimi model profile that has one, on its host. Nothing for the person to set up: Tomrade already offers a MOONSHOT_API_KEY it finds as a profile. */
export function kimiKey(profiles: ProfileLike[]): KimiKey | null {
  for (const profile of profiles) {
    const key = profile.apiKey?.trim();
    if (key && profile.baseURL && MOONSHOT.test(profile.baseURL)) return { key, origin: new URL(profile.baseURL).origin };
  }
  return null;
}

interface KimiResult {
  title?: string;
  url: string;
  date?: string;
  snippet?: string;
  chunks?: { text?: string }[];
}

interface KimiPage {
  url?: string;
  markdown?: string;
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const SPAN_DAYS: Record<NonNullable<SearchRequest["timeRange"]>, number> = { day: 1, week: 7, month: 31, year: 366 };

function window(range: NonNullable<SearchRequest["timeRange"]>, now: Date): { start: string; end: string } {
  return { start: day(new Date(now.getTime() - SPAN_DAYS[range] * 86_400_000)), end: day(now) };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function failure(status: number, body: string, retryAfter: string | null): string {
  if (status === 401) return "Kimi refused the API key — the user can check the Kimi model's key in Settings → Models";
  if (status === 403) return "Kimi refused this account (inactive, suspended, or the page was judged a security risk)";
  if (status === 429) return `Kimi is rate-limiting this key${retryAfter ? `; try again after ${retryAfter}` : ""}`;
  let message = body.slice(0, 300) || "no details";
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message;
  } catch {}
  return `Kimi answered ${status}: ${message}`;
}

export interface KimiOptions {
  /** Its id among the web search providers. */
  id: string;
  key(): KimiKey | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function kimiProvider({ id, key, fetch: send = fetch, now = () => new Date() }: KimiOptions): WebSearchProvider {
  async function call<T>(tool: "search" | "search_pro" | "fetch", body: object, signal: AbortSignal): Promise<T> {
    const found = key();
    if (!found) throw new Error("No Kimi API key");
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
    if (!response.ok) throw new Error(failure(response.status, text, response.headers.get("x-ratelimit-reset")));
    return JSON.parse(text) as T;
  }

  return {
    id,
    title: "Kimi",
    // A Kimi key lives on its model profile.
    settings: "assistant",
    unavailable: () => (key() ? null : "Web search through Kimi needs a Kimi model with an API key — the user can add one in Settings → Models (keys come from platform.moonshot.cn)"),

    async search(request, signal) {
      // Only the Pro search narrows by site or date; it costs a little more, so it is used only then.
      const sites = request.includeDomains?.slice(0, PRO_SITES_MAX);
      const pro = !!sites?.length || !!request.timeRange;
      const data = await call<{ search_results?: KimiResult[] }>(
        pro ? "search_pro" : "search",
        {
          text_query: request.query,
          limit: request.maxResults,
          timeout_seconds: TIMEOUT_SECONDS,
          ...(sites?.length && { sites }),
          ...(request.timeRange && { time_window: window(request.timeRange, now()) })
        },
        signal
      );
      const excluded = (request.excludeDomains ?? []).map((d) => d.toLowerCase());
      return {
        results: (data.search_results ?? [])
          .filter((r) => !excluded.some((d) => within(hostOf(r.url), d)))
          .map((r) => {
            const chunks = (r.chunks ?? []).map((c) => c.text?.trim()).filter(Boolean);
            return { title: r.title ?? "", url: r.url, content: chunks.length ? chunks.join("\n") : (r.snippet ?? ""), ...(r.date && { published: r.date }) };
          })
      };
    },

    // One page per request: Kimi's fetch takes a single URL.
    async read({ urls }, signal) {
      const out: ReadResponse = { pages: [], failed: [] };
      const settled = await Promise.allSettled(urls.map((url) => call<KimiPage>("fetch", { url }, signal)));
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") out.pages.push({ url: result.value.url || urls[i]!, content: result.value.markdown ?? "" });
        else out.failed.push({ url: urls[i]!, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      });
      return out;
    }
  };
}
