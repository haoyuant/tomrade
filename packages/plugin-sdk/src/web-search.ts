import type { Disposer } from "./contract.js";

type Maybe<T> = T | Promise<T>;

/** SDK 0.2.9. What the agent's `web_search` asks for; defaults are filled in before a provider sees it. */
export interface WebSearchRequest {
  query: string;
  maxResults: number;
  topic: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface WebSearchHit {
  title: string;
  url: string;
  /** An excerpt, not the page. */
  content: string;
  published?: string;
}

export interface WebReadRequest {
  urls: string[];
  /** Keep only the passages relevant to this. */
  query?: string;
}

export interface WebReadResponse {
  pages: { url: string; content: string }[];
  failed: { url: string; error: string }[];
}

/** One search backend, as the app's own providers are: the first registered one that is available answers. */
export interface WebSearchProviderSpec {
  /** Namespaced like every id a plugin registers. */
  id: string;
  title: string;
  /** Why it cannot answer yet (no API key, say), or null when it can. Called often and synchronously: keep it cheap. The agent reads it as the tool's error. */
  unavailable(): string | null;
  search(request: WebSearchRequest, signal: AbortSignal): Maybe<{ results: WebSearchHit[] }>;
  /** Pages as Markdown. Without it, `web_fetch` is left to another provider. */
  read?(request: WebReadRequest, signal: AbortSignal): Maybe<WebReadResponse>;
  /** The settings pane where the person sets it up: the plugin's own section id, or an app pane such as "assistant" (models). */
  settings?: string;
}

export interface WebSearchApi {
  /** Answers the agent's `web_search` (and `web_fetch`, with `read`) until disposed or the plugin unloads. */
  register(provider: WebSearchProviderSpec): Promise<Disposer>;
}
