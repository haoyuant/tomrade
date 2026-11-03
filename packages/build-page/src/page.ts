import type { Item } from "@tomradex/domain";
import type { BuildPageWords } from "./words.js";

/** What a person chose for a project's page. Nothing is ticked until they tick it. */
export interface PageConfig {
  /** "owner/repo" the page is published to and feedback is filed in. */
  repo: string | null;
  title: string;
  /** "Built with Tomrade" at the foot of the page. */
  footer: boolean;
  /** Ticked item ids: open ones go on the roadmap, merged ones in the changelog. */
  picks: string[];
}

export type Section = "roadmap" | "changelog";

/** A ticket that may go on the page, and where it would. */
export interface Candidate {
  id: string;
  key: string;
  title: string;
  status: Item["status"];
  section: Section;
  /** When its code was merged, for the changelog. */
  mergedAt: number | null;
}

/** Marks a page this package wrote, so a site someone else put on gh-pages is never overwritten. */
export const GENERATOR = "Tomrade build page";

const ROADMAP = new Set<Item["status"]>(["backlog", "todo", "doing", "verifying"]);
const NOW = new Set<Item["status"]>(["doing", "verifying"]);

/**
 * The tickets a person may tick: open tickets for the roadmap, done tickets
 * whose code was merged for the changelog. Epics and cancelled work are not offered.
 */
export function candidates(items: Item[], mergedAt: ReadonlyMap<string, number>): Candidate[] {
  const out: Candidate[] = [];
  for (const item of items) {
    if (item.kind !== "ticket") continue;
    const merged = mergedAt.get(item.id) ?? null;
    const section: Section | null = ROADMAP.has(item.status) ? "roadmap" : item.status === "done" && merged !== null ? "changelog" : null;
    if (section) out.push({ id: item.id, key: item.key, title: item.title, status: item.status, section, mergedAt: section === "changelog" ? merged : null });
  }
  return out.sort((a, b) => (a.section === b.section ? (a.section === "changelog" ? b.mergedAt! - a.mergedAt! : 0) : a.section === "roadmap" ? -1 : 1));
}

export interface PageContent {
  title: string;
  repo: string;
  /** BCP 47 tag of the page's language. */
  lang: string;
  now: { title: string }[];
  next: { title: string }[];
  changelog: { date: string; titles: string[] }[];
  feedbackUrl: string;
  footer: boolean;
  updated: string;
}

/** Only ticked candidates reach the page; only their titles leave the machine. */
export function content(config: PageConfig & { repo: string }, offered: Candidate[], lang: string, at: number, w: BuildPageWords): PageContent {
  const picked = new Set(config.picks);
  const ticked = offered.filter((c) => picked.has(c.id));
  const day = (ms: number) => new Intl.DateTimeFormat(lang, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(ms);
  const changelog: PageContent["changelog"] = [];
  for (const c of ticked.filter((c) => c.section === "changelog")) {
    const date = day(c.mergedAt!);
    const last = changelog.at(-1);
    if (last?.date === date) last.titles.push(c.title);
    else changelog.push({ date, titles: [c.title] });
  }
  const roadmap = ticked.filter((c) => c.section === "roadmap");
  return {
    title: config.title,
    repo: config.repo,
    lang,
    now: roadmap.filter((c) => NOW.has(c.status)).map((c) => ({ title: c.title })),
    next: roadmap.filter((c) => !NOW.has(c.status)).map((c) => ({ title: c.title })),
    changelog,
    feedbackUrl: feedbackUrl(config.repo, w),
    footer: config.footer,
    updated: day(at)
  };
}

export function feedbackUrl(repo: string, w: BuildPageWords): string {
  return `https://github.com/${repo}/issues/new?${new URLSearchParams({ body: `\n\n---\n${w("feedbackFooter")}` }).toString()}`;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const list = (titles: string[], empty: string) => (titles.length ? `<ul>${titles.map((t) => `<li>${escape(t)}</li>`).join("")}</ul>` : `<p class="empty">${escape(empty)}</p>`);

/** One self-contained page: no script, no request beyond the feedback link. */
export function renderPage(page: PageContent, w: BuildPageWords): string {
  const roadmap = page.now.length || page.next.length;
  return `<!doctype html>
<html lang="${escape(page.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${GENERATOR}">
<title>${escape(page.title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#fbfbfd;--card:#fff;--line:#e5e5ea;--accent:#d9622b}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#111113;--card:#1c1c1e;--line:#2c2c2e;--accent:#f08a4b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 16px 32px}
h1{font-size:2rem;margin:0 0 4px}h2{font-size:1.25rem;margin:40px 0 12px}h3{font-size:.95rem;color:var(--muted);margin:16px 0 4px;font-weight:600}
.meta,.empty{color:var(--muted);font-size:.9rem}ul{margin:0;padding-left:1.2em}li{margin:4px 0}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 20px 16px;margin-top:16px}
a.button{display:inline-block;margin-top:8px;padding:8px 18px;border-radius:999px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
footer{max-width:720px;margin:0 auto;padding:16px;color:var(--muted);font-size:.85rem;text-align:center}footer a{color:inherit}
</style>
</head>
<body>
<main>
<h1>${escape(page.title)}</h1>
<p class="meta">${escape(w("updated", { date: page.updated }))}</p>
<section>
<h2>${escape(w("roadmap"))}</h2>
${
  roadmap
    ? `${page.now.length ? `<h3>${escape(w("inProgress"))}</h3>${list(page.now.map((r) => r.title), "")}` : ""}${page.next.length ? `<h3>${escape(w("planned"))}</h3>${list(page.next.map((r) => r.title), "")}` : ""}`
    : `<p class="empty">${escape(w("nothingYet"))}</p>`
}
</section>
<section>
<h2>${escape(w("changelog"))}</h2>
${page.changelog.length ? page.changelog.map((d) => `<h3>${escape(d.date)}</h3>${list(d.titles, "")}`).join("\n") : `<p class="empty">${escape(w("nothingYet"))}</p>`}
</section>
<section>
<h2>${escape(w("feedback"))}</h2>
<p>${escape(w("feedbackLede"))}</p>
<a class="button" href="${escape(page.feedbackUrl)}" target="_blank" rel="noopener">${escape(w("feedbackButton"))}</a>
</section>
</main>
${page.footer ? `<footer>${escape(w("builtWith"))} <a href="https://tomrade.com" target="_blank" rel="noopener">Tomrade</a></footer>\n` : ""}</body>
</html>
`;
}
