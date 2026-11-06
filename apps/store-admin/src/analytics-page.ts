import { en, translator, type MessageKey } from "./analytics-messages.js";
import { FUNNEL_STEPS, WINDOWS, regions, windowOf, windowStart, type Card, type DashboardData, type Filters, type View, type WindowDays } from "./analytics-data.js";
import type { InsightsState } from "./analytics-insights.js";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Inside <script type="application/json">: `<` could close the element, U+2028/9 break older parsers.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** What the browser script needs to draw the charts; the tables below carry the same numbers without it. */
export interface ChartPayload {
  lang: "en" | "zh"; to: string; metric: Filters["metric"]; feature: string;
  /** Each chart's first day: every window ends on `to`. */
  from: Record<"spark" | "overview" | "detail" | "retention" | "growth", string>;
  t: Partial<Record<MessageKey, string>>;
  /** The headline sparklines, over the page's window. */
  spark: DashboardData["report"]["daily"];
  daily: DashboardData["report"]["daily"];
  /** The ranking card's features, ranked by the metric. */
  features: DashboardData["report"]["features"];
  /** The features the trend card's window has, for its picker. */
  detailFeatures: string[];
  days: { day: string; feature_id: string; duration_ms: number; uses: number }[];
  retention: { day: string; cohort: number; d1: number; mature: boolean }[];
  /** Days with site or account rows; the chart is left out when there are none. */
  growth: { day: string; accounts: number | null; installs: number | null; updates: number | null; pageviews: number | null }[];
}
const CHART_WORDS: MessageKey[] = ["duration", "uses", "activeIds", "rate", "cohort", "returned", "pending", "today", "newAccounts", "siteInstalls", "updates", "pageviews", "generating"];
const WINDOW_WORDS: Record<WindowDays, MessageKey> = { 7: "days7", 30: "days30", 90: "days90", 180: "days180", 365: "days365" };

export function renderDashboard(f: Filters, view?: View, error?: "failed" | "invalid", insights?: InsightsState): string {
  const t = translator(f.lang);
  const n = (value: number) => new Intl.NumberFormat(f.lang, { maximumFractionDigits: 1 }).format(value);
  const compact = (value: number) => new Intl.NumberFormat(f.lang, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const fill = (text: string, slots: Record<string, number | string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(slots[k] ?? ""));
  type Patch = Partial<Record<"days" | "region" | "metric" | "lang" | "feature", string>>;
  // Every link carries the whole view; a card's window is written only where it differs from the page's.
  const query = (patch: Patch = {}, windows: Partial<Record<Card, WindowDays>> = {}) => {
    const params = new URLSearchParams({ days: String(f.days), region: f.region, metric: f.metric, lang: f.lang, ...(f.feature ? { feature: f.feature } : {}), ...patch });
    const days = Number(params.get("days"));
    for (const [card, w] of Object.entries({ ...f.windows, ...windows })) if (w !== days) params.set(`w_${card}`, String(w));
    return `?${params.toString()}`;
  };
  const href = (patch: Patch = {}, windows: Partial<Record<Card, WindowDays>> = {}, hash = "") => `/${query(patch, windows)}${hash}`;
  const segmented = (label: string, options: [string, string, string][], selected: string, cls = "seg") =>
    `<div class="${cls}" role="group" aria-label="${escape(label)}">${options.map(([value, text, link]) => `<a href="${escape(link)}"${value === selected ? ' aria-current="true"' : ""}>${escape(text)}</a>`).join("")}</div>`;
  const table = (heads: string[], rows: string[][], numeric = 1) => `<div class="table"><table><thead><tr>${heads.map((h, i) => `<th${i >= numeric ? ' class="num"' : ""}>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i >= numeric ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  // A card's own window: its picker, and its dates when they differ from the page's.
  const windowControl = (card: Card) => {
    const w = windowOf(f, card);
    const picker = segmented(t("window"), WINDOWS.map((d) => [String(d), t(WINDOW_WORDS[d]), href({}, { [card]: d }, `#card-${card}`)]), String(w), "seg small");
    return `${w !== f.days ? `<span class="range">${escape(fill(t("windowRange"), { from: windowStart(f.to, w), to: f.to }))}</span>` : ""}${picker}`;
  };
  const card = (o: { id: string; title: string; hint?: string; body: string; extra?: string; span: string; windowed?: Card }) =>
    `<section class="card ${o.span}" id="card-${o.id}"><header><div><h2>${escape(o.title)}</h2>${o.hint ? `<p>${escape(o.hint)}</p>` : ""}</div><div class="tools">${o.extra ?? ""}${o.windowed ? windowControl(o.windowed) : ""}</div></header>${o.body}</section>`;

  const data = view?.get(f.days);
  const at = (c: Card) => view!.get(windowOf(f, c))!;
  const ranked = (d: DashboardData) => [...d.report.features].sort((a, b) => b[f.metric] - a[f.metric] || a.feature_id.localeCompare(b.feature_id));
  const features = view && data ? ranked(at("ranking")) : [];
  const detailFeatures = view && data ? ranked(at("detail")) : [];
  const selected = [...features, ...detailFeatures].some((row) => row.feature_id === f.feature) ? f.feature : features[0]?.feature_id ?? detailFeatures[0]?.feature_id ?? "";

  let content = "";
  if (error) content = `<p role="alert" class="notice error">${t(error)}</p>`;
  else if (view && data && !data.report.daily.length && !data.report.features.length) content = `<p role="status" class="notice">${t("empty")}</p>`;
  else if (view && data) {
    const { report } = data;
    const today = report.daily.find((d) => d.day === f.to);
    const minutes = report.totals.duration_ms / 60000;
    const kpi = (label: string, value: number | null, sub: string, spark: string) =>
      `<article class="kpi"><span class="label">${escape(label)}</span><strong title="${value === null ? "" : escape(n(value))}">${value === null ? "—" : escape(compact(value))}</strong><span class="sub">${sub}</span><div class="spark" data-spark="${spark}"></div></article>`;
    const mature = (d: { day: string }) => Date.parse(d.day) + 86400000 < Date.parse(f.to);
    const retentionRows = at("retention").report.retention.map((d) => ({ ...d, mature: mature(d) }));
    const payload: ChartPayload = {
      lang: f.lang, to: f.to, metric: f.metric, feature: selected,
      from: { spark: f.from, overview: windowStart(f.to, windowOf(f, "overview")), detail: windowStart(f.to, windowOf(f, "detail")), retention: windowStart(f.to, windowOf(f, "retention")), growth: windowStart(f.to, windowOf(f, "growth")) },
      t: Object.fromEntries(CHART_WORDS.map((k) => [k, t(k)])),
      spark: report.daily, daily: at("overview").report.daily, features,
      detailFeatures: detailFeatures.map((d) => d.feature_id),
      days: at("detail").days.map(({ day, feature_id, duration_ms, uses }) => ({ day, feature_id, duration_ms, uses })),
      retention: retentionRows, growth: growthDays(at("growth"))
    };
    const percent = (part: number, whole: number) => (whole ? `${n(part / whole * 100)}%` : "—");
    const span = (ms: number) => ms < 3600000 ? fill(t("minutesShort"), { n: n(ms / 60000) }) : ms < 86400000 ? fill(t("hoursShort"), { n: n(ms / 3600000) }) : fill(t("daysShort"), { n: n(ms / 86400000) });
    const stepNames: Record<typeof FUNNEL_STEPS[number], MessageKey> = { installs: "installs", setup_done: "setupDone", start: "firstStart", open_pr: "openPr", merge: "merged" };
    const stat = (label: string, value: string, sub: string) => `<article class="stat"><span class="label">${escape(label)}</span><strong>${escape(value)}</strong><span class="sub">${escape(sub)}</span></article>`;
    const label = (key: string) => (key in en ? t(key as MessageKey) : key);
    const shareCell = (part: number, whole: number) => `<span class="share"><span style="width:${(whole ? part / whole * 100 : 0).toFixed(1)}%"></span></span>${percent(part, whole)}`;

    // The site's installer downloads come first when the sync has run: installs over downloads is the conversion.
    const { activation, site: funnelSite } = at("activation");
    const downloads = funnelSite?.totals.installs ?? null;
    const funnel = FUNNEL_STEPS.map((step, i) => {
      const reached = activation.funnel[step];
      const installs = activation.funnel.installs;
      const previous = i ? activation.funnel[FUNNEL_STEPS[i - 1]!] : downloads;
      const width = installs ? reached / installs * 100 : 0;
      return [escape(t(stepNames[step])), n(reached), `<span class="share"><span style="width:${width.toFixed(1)}%"></span></span>${percent(reached, installs)}`, previous === null ? "—" : percent(reached, previous)];
    });
    if (downloads !== null) funnel.unshift([escape(t("downloads")), n(downloads), "—", "—"]);

    const growth = at("growth");
    const { site, accounts } = growth;
    const growthCard = card({ id: "growth", title: t("growth"), hint: t("growthHint"), span: "s12 w8", windowed: "growth",
      extra: `<span class="pill">${escape(t("synced"))} · ${escape(site?.synced_at ? site.synced_at.replace("T", " ").slice(0, 16) : t("notSynced"))}</span>`,
      body: `<div class="stats four">
        ${stat(t("accounts"), accounts ? n(accounts.total) : "—", accounts ? fill(t("accountsSub"), { confirmed: n(accounts.confirmed) }) : t("accountsMissing"))}
        ${stat(t("newAccounts"), accounts ? n(accounts.new) : "—", t("newAccountsSub"))}
        ${stat(t("siteInstalls"), site ? n(site.totals.installs) : "—", site ? fill(t("siteInstallsSub"), { updates: n(site.totals.updates) }) : t("siteMissing"))}
        ${stat(t("pageviews"), site ? n(site.totals.pageviews) : "—", site ? fill(t("pageviewsSub"), { visits: n(site.totals.visits) }) : "")}
      </div>${site || accounts ? `<div class="chart" id="chart-growth" role="img" aria-label="${escape(t("growth"))}"></div>` : ""}
      ${site?.platforms.length ? `<h3>${escape(t("downloadsByPlatform"))}</h3>${table([t("platform"), t("siteInstalls"), t("share"), t("updates")], site.platforms.map((d) => [escape(label(d.platform)), n(d.installs), shareCell(d.installs, site.totals.installs), n(d.updates)]))}` : ""}` });

    const activationCard = card({ id: "activation", title: t("activation"), hint: t("activationHint"), span: "s12 w4", windowed: "activation", body: `<div class="stats">
        ${stat(t("timeToStart"), activation.first_start.median_ms === null ? "—" : span(activation.first_start.median_ms), fill(t("timeToStartSub"), { n: n(activation.first_start.n) }))}
        ${stat(t("merged7d"), percent(activation.merged_7d.merged, activation.merged_7d.cohort), fill(t("merged7dSub"), { merged: n(activation.merged_7d.merged), cohort: n(activation.merged_7d.cohort) }))}
        ${stat(t("weekReturn"), percent(activation.week_return.returned, activation.week_return.cohort), fill(t("weekReturnSub"), { returned: n(activation.week_return.returned), cohort: n(activation.week_return.cohort) }))}
      </div>${table([t("step"), t("reached"), t("ofInstalls"), t("ofPrevious")], funnel)}` });

    // The platform card is left out where no deployment reports platforms, unless its window was chosen apart.
    const platforms = at("platforms").platforms;
    const showPlatforms = platforms.length > 0 || f.windows.platforms !== undefined;
    const usedIds = platforms.reduce((sum, d) => sum + d.aai, 0);
    const usedTime = platforms.reduce((sum, d) => sum + d.duration_ms, 0);
    const platformCard = showPlatforms ? card({ id: "platforms", title: t("platforms"), hint: t("platformsHint"), span: "s12 w4", windowed: "platforms",
      body: table([t("platform"), t("activeIds"), t("ofIds"), t("duration"), t("ofTime")],
        platforms.map((d) => [escape(label(d.platform)), n(d.aai), shareCell(d.aai, usedIds), n(d.duration_ms / 60000), shareCell(d.duration_ms, usedTime)])) }) : "";

    const featureDays = windowOf(f, "features");
    const featureRows = ranked(at("features"));
    const total = featureRows.reduce((sum, d) => sum + d[f.metric], 0);
    const featureCard = card({ id: "features", title: t("features"), span: showPlatforms ? "s12 w8" : "s12", windowed: "features",
      body: table([t("feature"), t("duration"), t("uses"), t("activeIds"), t("share"), `${t("minutes")} / ${t("perDay")}`, `${t("uses")} / ${t("perDay")}`], featureRows.map((d) => {
        const share = total ? d[f.metric] / total * 100 : 0;
        return [`<a href="${escape(href({ feature: d.feature_id }, {}, "#card-detail"))}" data-feature="${escape(d.feature_id)}"${d.feature_id === selected ? ' aria-current="true"' : ""}>${escape(d.feature_id)}</a>`,
          n(d.duration_ms / 60000), n(d.uses), n(d.aai),
          `<span class="share"><span style="width:${share.toFixed(1)}%"></span></span>${n(share)}%`,
          n(d.duration_ms / 60000 / featureDays), n(d.uses / featureDays)];
      })) });

    const retention = report.retention.map((d) => ({ ...d, mature: mature(d) }));
    content = `<div class="kpis">
      ${kpi(t("active"), today ? today.aai : null, escape(f.to), "aai")}
      ${kpi(t("periodActive"), report.totals.aai, `${escape(f.from)} — ${escape(f.to)}`, "aai")}
      ${kpi(t("duration"), minutes, `${escape(n(minutes / f.days))} ${escape(t("perDay"))}`, "duration")}
      ${kpi(t("uses"), report.totals.uses, `${escape(n(report.totals.uses / f.days))} ${escape(t("perDay"))}`, "uses")}
    </div>
    <div class="board">
      ${insights ? insightsCard(insights) : ""}
      ${card({ id: "overview", title: t("overview"), hint: t("overviewHint"), span: "s8", windowed: "overview", body: `<div class="chart tall" id="chart-overview" role="img" aria-label="${escape(t("overview"))}"></div>` })}
      ${card({ id: "ranking", title: t("ranking"), hint: t("rankingHint"), span: "s4", windowed: "ranking", body: `<div class="chart tall" id="chart-ranking" role="img" aria-label="${escape(t("ranking"))}"></div>`,
        extra: segmented(t("metric"), [["duration_ms", t("duration"), href({ metric: "duration_ms" }, {}, "#card-ranking")], ["uses", t("uses"), href({ metric: "uses" }, {}, "#card-ranking")]], f.metric, "seg small") })}
      ${card({ id: "detail", title: t("detail"), span: "s8", windowed: "detail", body: `<div class="chart" id="chart-detail" role="img" aria-label="${escape(t("detail"))}"></div>`,
        extra: `<label class="pick"><span>${escape(t("feature"))}</span><select id="feature-pick">${detailFeatures.map((d) => `<option value="${escape(d.feature_id)}"${d.feature_id === selected ? " selected" : ""}>${escape(d.feature_id)}</option>`).join("")}</select></label>` })}
      ${card({ id: "retention", title: t("retention"), hint: t("retentionHint"), span: "s4", windowed: "retention", body: `<div class="chart" id="chart-retention" role="img" aria-label="${escape(t("retention"))}"></div>` })}
      ${growthCard}
      ${activationCard}
      ${featureCard}
      ${platformCard}
      <details class="card s12"><summary>${escape(t("dailyData"))}</summary>
        <div class="split">
          ${table([t("day"), t("activeIds"), t("duration"), t("uses")], report.daily.map((d) => [escape(d.day), n(d.aai), n(d.duration_ms / 60000), n(d.uses)]))}
          ${table([t("day"), t("cohort"), t("returned"), t("rate")], retention.map((d) => [escape(d.day), n(d.cohort), d.mature ? n(d.d1) : t("pending"), d.mature && d.cohort ? `${n(d.d1 / d.cohort * 100)}%` : t("pending")]))}
        </div>
      </details>
    </div>
    <script type="application/json" id="dashboard-data">${json(payload)}</script>
    <script src="/assets/echarts.min.js"></script><script type="module" src="/assets/dashboard.js"></script>`;
  }

  function insightsCard(state: InsightsState): string {
    const { entry } = state;
    const time = (iso: string) => iso.replace("T", " ").slice(0, 16);
    const other = entry && (entry.region !== f.region || entry.days !== f.days);
    const button = `<form method="post" action="/insights${escape(query())}" class="generate"><button type="submit"${state.running ? " disabled" : ""}>${escape(state.running ? t("generating") : entry && !other ? t("regenerate") : t("generate"))}</button></form>`;
    const notices = [
      state.error ? `<p role="alert" class="notice-inline error">${escape(state.error.kind === "unavailable" ? t("insightsUnavailable") : fill(t("insightsFailed"), { at: time(state.error.at) }))}</p>` : "",
      other ? `<p class="notice-inline">${escape(t("insightsOther"))}</p>` : ""
    ].join("");
    let body = `<p class="muted">${escape(t("insightsNone"))}</p>`;
    if (entry) {
      const { insights } = entry;
      const list = (rows: string[], empty = "") => rows.length ? `<ul>${rows.join("")}</ul>` : `<p class="muted">${escape(empty)}</p>`;
      const tag = (cls: string, text: string) => `<span class="tag ${cls}">${escape(text)}</span>`;
      body = `<p class="summary">${escape(insights.summary)}</p>
        <div class="insights">
          <div><h3>${escape(t("highlights"))}</h3>${list(insights.highlights.map((h) => `<li class="tone-${h.tone}"><strong>${escape(h.title)}</strong><span>${escape(h.detail)}</span></li>`))}</div>
          <div><h3>${escape(t("anomalies"))}</h3>${list(insights.anomalies.map((a) => `<li class="tone-bad"><strong>${escape(a.title)}</strong><span>${escape(a.detail)}</span></li>`), t("noAnomalies"))}</div>
          <div><h3>${escape(t("suggestions"))}</h3>${list(insights.suggestions.map((s) => `<li><strong>${tag(s.priority, t(s.priority))}${escape(s.title)}</strong><span>${escape(s.detail)}</span></li>`))}</div>
        </div>`;
    }
    const basis = entry ? `<span class="pill">${escape(fill(t("insightsBasis"), { from: entry.from, to: entry.to, region: t(entry.region), at: time(entry.generated_at) }))}${entry.cost_usd !== null ? ` · ${escape(fill(t("insightsCost"), { cost: entry.cost_usd.toFixed(3) }))}` : ""}</span>` : "";
    return card({ id: "insights", title: t("insights"), hint: t("insightsHint"), span: "s12 ai", extra: `${basis}${button}`, body: notices + body });
  }

  const latest = view && data ? data.report.latest : undefined;
  return `<!doctype html><html lang="${f.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${t("title")}</title><style>${STYLE}</style></head>
<body><div class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><div><h1>${t("title")}</h1><p>${t("subtitle")}</p></div></div>
  <div class="actions">${latest !== undefined ? `<span class="pill"><span class="dot${latest ? "" : " off"}"></span>${escape(t("latest"))} · ${escape(latest ? latest.replace("T", " ").slice(0, 16) : t("none"))}</span>` : ""}
  ${segmented(t("language"), [["zh", "中文", href({ lang: "zh" })], ["en", "EN", href({ lang: "en" })]], f.lang)}
  <a class="button" href="${escape(href({}))}">${escape(t("refresh"))}</a></div></div>
<main><nav class="filters" aria-label="${escape(t("range"))}">
  ${segmented(t("range"), WINDOWS.map((d) => [String(d), t(WINDOW_WORDS[d]), href({ days: String(d) })]), String(f.days))}
  <div class="chips" role="group" aria-label="${escape(t("region"))}">${regions.map((r) => `<a href="${escape(href({ region: r }))}"${r === f.region ? ' aria-current="true"' : ""}>${escape(t(r))}</a>`).join("")}</div>
  <span class="range">${escape(f.from)} — ${escape(f.to)}</span></nav>
${content}<p class="note">${t("note")}</p></main></body></html>`;
}

function growthDays(data: DashboardData): ChartPayload["growth"] {
  const days = new Map<string, ChartPayload["growth"][number]>();
  const row = (day: string) => days.get(day) ?? days.set(day, { day, accounts: null, installs: null, updates: null, pageviews: null }).get(day)!;
  for (const d of data.accounts?.daily ?? []) row(d.day).accounts = d.new;
  for (const d of data.site?.daily ?? []) Object.assign(row(d.day), { installs: d.installs, updates: d.updates, pageviews: d.pageviews });
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const STYLE = `
:root{--bg:#f4f6fa;--surface:#fff;--raised:#f8fafc;--line:#e4e8ef;--text:#111827;--muted:#64748b;--accent:#4f46e5;--accent-soft:#eef2ff;
--c1:#4f46e5;--c2:#0ea5a4;--c3:#f59e0b;--danger:#be123c;--danger-soft:#fff1f2;--ok:#16a34a;--shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--surface:#121826;--raised:#182032;--line:#243046;--text:#e5e9f2;--muted:#8b97ad;--accent:#818cf8;--accent-soft:#1e2340;
--c1:#818cf8;--c2:#2dd4bf;--c3:#fbbf24;--danger:#fda4af;--danger-soft:#2a1520;--ok:#4ade80;--shadow:none}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:14px max(16px,calc((100vw - 2400px)/2));background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}.mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--c1),var(--c2))}
h1{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}.brand p{margin:0;color:var(--muted);font-size:12px}
.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}.dot.off{background:var(--muted)}
.button{padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font-weight:550;font-size:13px}.button:hover{text-decoration:none;filter:brightness(1.08)}
main{max-width:2400px;margin:0 auto;padding:20px max(16px,2vw) 48px}
.filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}.range{margin-left:auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.seg{display:inline-flex;padding:3px;border-radius:10px;background:var(--raised);border:1px solid var(--line)}
.seg a{padding:4px 12px;border-radius:7px;color:var(--muted);font-size:13px;white-space:nowrap}.seg a:hover{text-decoration:none;color:var(--text)}
.seg a[aria-current]{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips a{padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:13px}
.chips a:hover{text-decoration:none;color:var(--text)}.chips a[aria-current]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px}.stats.four{grid-template-columns:repeat(4,minmax(0,1fr))}
h3{margin:16px 0 4px;font-size:13px;font-weight:600;color:var(--muted)}
.stat{display:flex;flex-direction:column;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}
.stat .label{color:var(--muted);font-size:12px}.stat strong{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.stat .sub{color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:16px}
.kpi{position:relative;display:flex;flex-direction:column;padding:16px 18px 0;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;min-height:150px}
.kpi .label{color:var(--muted);font-size:12.5px}.kpi strong{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.25;margin-top:6px;font-variant-numeric:tabular-nums}
.kpi .sub{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.spark{height:46px;margin:6px -18px 0}
.board{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;margin-bottom:16px}
.board>.s12{grid-column:span 12}.board>.s8{grid-column:span 8}.board>.s4{grid-column:span 4}
@media (min-width:1500px){.board>.w8{grid-column:span 8}.board>.w4{grid-column:span 4}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:18px;min-width:0;scroll-margin-top:84px}
.card>header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.card .range{margin:0}
.seg.small a{padding:3px 9px;font-size:12px}
.muted{color:var(--muted)}
.generate{margin:0}.generate button{padding:6px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:550;cursor:pointer}
.generate button:hover{filter:brightness(1.08)}.generate button[disabled]{opacity:.6;cursor:progress}
.ai{background:linear-gradient(180deg,var(--accent-soft),var(--surface) 120px)}
.summary{margin:4px 0 14px;font-size:15px;line-height:1.6;max-width:1100px}
.insights{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.insights h3{margin:0 0 8px}
.insights ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.insights li{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--line);border-radius:10px;background:var(--surface)}
.insights li span{color:var(--muted);font-size:13px}.insights li.tone-good{border-left-color:var(--ok)}.insights li.tone-bad{border-left-color:var(--danger)}
.tag{display:inline-block;margin-right:6px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:600;vertical-align:1px;background:var(--raised);color:var(--muted)}
.tag.high{background:var(--danger-soft);color:var(--danger)}.tag.medium{background:var(--accent-soft);color:var(--accent)}
.notice-inline{margin:0 0 12px;padding:8px 12px;border-radius:8px;background:var(--raised);color:var(--muted);font-size:13px}.notice-inline.error{background:var(--danger-soft);color:var(--danger)}
h2{margin:0;font-size:15px;font-weight:620}.card>header p{margin:2px 0 0;color:var(--muted);font-size:12px}
.chart{height:280px;display:grid;place-items:center;color:var(--muted)}.chart.tall{height:340px}
.pick{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
select{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--raised);color:var(--text);font:inherit;max-width:240px}
.table{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{position:sticky;top:0;background:var(--surface);color:var(--muted);font-size:12px;font-weight:550}
.num{text-align:right}tbody tr:hover{background:var(--raised)}tbody tr:last-child td{border-bottom:0}
td a[aria-current]{font-weight:650}
.share{display:inline-block;vertical-align:middle;width:72px;height:6px;margin-right:8px;border-radius:3px;background:var(--raised);overflow:hidden}.share span{display:block;height:100%;background:var(--c1);border-radius:3px}
details>summary{cursor:pointer;font-weight:620;font-size:15px}details[open]>summary{margin-bottom:12px}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;max-height:420px;overflow:auto}
.notice{padding:48px 24px;text-align:center;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:14px}
.notice.error{color:var(--danger);background:var(--danger-soft);border:1px solid var(--danger)}
.note{color:var(--muted);font-size:12px;max-width:760px}
@media (max-width:1000px){.kpis,.stats.four{grid-template-columns:repeat(2,minmax(0,1fr))}.split,.insights{grid-template-columns:minmax(0,1fr)}.board>.card{grid-column:span 12}}
@media (max-width:560px){.kpis,.stats,.stats.four{grid-template-columns:minmax(0,1fr)}.range{margin-left:0}.top{position:static}}
`;
