import { translator, type MessageKey } from "./analytics-messages.js";
import { FUNNEL_STEPS, regions, type DashboardData, type Filters } from "./analytics-data.js";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Inside <script type="application/json">: `<` could close the element, U+2028/9 break older parsers.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** What the browser script needs to draw the charts; the tables below carry the same numbers without it. */
export interface ChartPayload {
  lang: "en" | "zh"; from: string; to: string; metric: Filters["metric"]; feature: string;
  t: Partial<Record<MessageKey, string>>;
  daily: DashboardData["report"]["daily"];
  features: DashboardData["report"]["features"];
  days: { day: string; feature_id: string; duration_ms: number; uses: number }[];
  retention: { day: string; cohort: number; d1: number; mature: boolean }[];
}
const CHART_WORDS: MessageKey[] = ["duration", "uses", "activeIds", "rate", "cohort", "returned", "pending", "today"];

export function renderDashboard(f: Filters, data?: DashboardData, error?: "failed" | "invalid"): string {
  const t = translator(f.lang);
  const n = (value: number) => new Intl.NumberFormat(f.lang, { maximumFractionDigits: 1 }).format(value);
  const compact = (value: number) => new Intl.NumberFormat(f.lang, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const href = (patch: Partial<Record<"days" | "region" | "metric" | "lang" | "feature", string>>) =>
    `/?${new URLSearchParams({ days: String(f.days), region: f.region, metric: f.metric, lang: f.lang, ...(f.feature ? { feature: f.feature } : {}), ...patch }).toString()}`;
  const segmented = (label: string, options: [string, string, string][], selected: string) =>
    `<div class="seg" role="group" aria-label="${escape(label)}">${options.map(([value, text, link]) => `<a href="${escape(link)}"${value === selected ? ' aria-current="true"' : ""}>${escape(text)}</a>`).join("")}</div>`;
  const table = (heads: string[], rows: string[][], numeric = 1) => `<div class="table"><table><thead><tr>${heads.map((h, i) => `<th${i >= numeric ? ' class="num"' : ""}>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i >= numeric ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const card = (title: string, hint: string, body: string, extra = "", wide = false) =>
    `<section class="card${wide ? " wide" : ""}"><header><div><h2>${escape(title)}</h2>${hint ? `<p>${escape(hint)}</p>` : ""}</div>${extra}</header>${body}</section>`;

  const features = [...(data?.report.features ?? [])].sort((a, b) => b[f.metric] - a[f.metric] || a.feature_id.localeCompare(b.feature_id));
  const selected = features.some((row) => row.feature_id === f.feature) ? f.feature : features[0]?.feature_id ?? "";

  let content = "";
  if (error) content = `<p role="alert" class="notice error">${t(error)}</p>`;
  else if (data && !data.report.daily.length && !features.length) content = `<p role="status" class="notice">${t("empty")}</p>`;
  else if (data) {
    const { report } = data;
    const today = report.daily.find((d) => d.day === f.to);
    const minutes = report.totals.duration_ms / 60000;
    const kpi = (label: string, value: number | null, sub: string, spark: string) =>
      `<article class="kpi"><span class="label">${escape(label)}</span><strong title="${value === null ? "" : escape(n(value))}">${value === null ? "—" : escape(compact(value))}</strong><span class="sub">${sub}</span><div class="spark" data-spark="${spark}"></div></article>`;
    const total = features.reduce((sum, d) => sum + d[f.metric], 0);
    const retention = report.retention.map((d) => ({ ...d, mature: Date.parse(d.day) + 86400000 < Date.parse(f.to) }));
    const payload: ChartPayload = {
      lang: f.lang, from: f.from, to: f.to, metric: f.metric, feature: selected,
      t: Object.fromEntries(CHART_WORDS.map((k) => [k, t(k)])),
      daily: report.daily, features,
      days: data.days.map(({ day, feature_id, duration_ms, uses }) => ({ day, feature_id, duration_ms, uses })),
      retention
    };
    const fill = (text: string, slots: Record<string, number | string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(slots[k] ?? ""));
    const percent = (part: number, whole: number) => (whole ? `${n(part / whole * 100)}%` : "—");
    const span = (ms: number) => ms < 3600000 ? fill(t("minutesShort"), { n: n(ms / 60000) }) : ms < 86400000 ? fill(t("hoursShort"), { n: n(ms / 3600000) }) : fill(t("daysShort"), { n: n(ms / 86400000) });
    const { activation } = data;
    const stepNames: Record<typeof FUNNEL_STEPS[number], MessageKey> = { installs: "installs", setup_done: "setupDone", start: "firstStart", open_pr: "openPr", merge: "merged" };
    const funnel = FUNNEL_STEPS.map((step, i) => {
      const reached = activation.funnel[step];
      const installs = activation.funnel.installs;
      const previous = i ? activation.funnel[FUNNEL_STEPS[i - 1]!] : installs;
      const width = installs ? reached / installs * 100 : 0;
      return [escape(t(stepNames[step])), n(reached), `<span class="share"><span style="width:${width.toFixed(1)}%"></span></span>${percent(reached, installs)}`, i ? percent(reached, previous) : "—"];
    });
    const stat = (label: string, value: string, sub: string) => `<article class="stat"><span class="label">${escape(label)}</span><strong>${escape(value)}</strong><span class="sub">${escape(sub)}</span></article>`;
    const activationCard = card(t("activation"), t("activationHint"), `<div class="stats">
        ${stat(t("timeToStart"), activation.first_start.median_ms === null ? "—" : span(activation.first_start.median_ms), fill(t("timeToStartSub"), { n: n(activation.first_start.n) }))}
        ${stat(t("merged7d"), percent(activation.merged_7d.merged, activation.merged_7d.cohort), fill(t("merged7dSub"), { merged: n(activation.merged_7d.merged), cohort: n(activation.merged_7d.cohort) }))}
        ${stat(t("weekReturn"), percent(activation.week_return.returned, activation.week_return.cohort), fill(t("weekReturnSub"), { returned: n(activation.week_return.returned), cohort: n(activation.week_return.cohort) }))}
      </div>${table([t("step"), t("reached"), t("ofInstalls"), t("ofPrevious")], funnel)}`);
    content = `<div class="kpis">
      ${kpi(t("active"), today ? today.aai : null, escape(f.to), "aai")}
      ${kpi(t("periodActive"), report.totals.aai, `${escape(f.from)} — ${escape(f.to)}`, "aai")}
      ${kpi(t("duration"), minutes, `${escape(n(minutes / f.days))} ${escape(t("perDay"))}`, "duration")}
      ${kpi(t("uses"), report.totals.uses, `${escape(n(report.totals.uses / f.days))} ${escape(t("perDay"))}`, "uses")}
    </div>
    <div class="grid">
      ${card(t("overview"), t("overviewHint"), `<div class="chart tall" id="chart-overview" role="img" aria-label="${escape(t("overview"))}"></div>`, "", true)}
      ${card(t("ranking"), t("rankingHint"), `<div class="chart tall" id="chart-ranking" role="img" aria-label="${escape(t("ranking"))}"></div>`,
        segmented(t("metric"), [["duration_ms", t("duration"), href({ metric: "duration_ms" })], ["uses", t("uses"), href({ metric: "uses" })]], f.metric))}
      ${card(`${t("detail")}`, "", `<div class="chart" id="chart-detail" role="img" aria-label="${escape(t("detail"))}"></div>`,
        `<label class="pick"><span>${escape(t("feature"))}</span><select id="feature-pick">${features.map((d) => `<option value="${escape(d.feature_id)}"${d.feature_id === selected ? " selected" : ""}>${escape(d.feature_id)}</option>`).join("")}</select></label>`, true)}
      ${card(t("retention"), t("retentionHint"), `<div class="chart" id="chart-retention" role="img" aria-label="${escape(t("retention"))}"></div>`)}
    </div>
    ${activationCard}
    ${card(t("features"), "", table([t("feature"), t("duration"), t("uses"), t("activeIds"), t("share"), `${t("minutes")} / ${t("perDay")}`, `${t("uses")} / ${t("perDay")}`], features.map((d) => {
      const share = total ? d[f.metric] / total * 100 : 0;
      return [`<a href="${escape(href({ feature: d.feature_id }))}" data-feature="${escape(d.feature_id)}"${d.feature_id === selected ? ' aria-current="true"' : ""}>${escape(d.feature_id)}</a>`,
        n(d.duration_ms / 60000), n(d.uses), n(d.aai),
        `<span class="share"><span style="width:${share.toFixed(1)}%"></span></span>${n(share)}%`,
        n(d.duration_ms / 60000 / f.days), n(d.uses / f.days)];
    })))}
    <details class="card"><summary>${escape(t("dailyData"))}</summary>
      <div class="split">
        ${table([t("day"), t("activeIds"), t("duration"), t("uses")], report.daily.map((d) => [escape(d.day), n(d.aai), n(d.duration_ms / 60000), n(d.uses)]))}
        ${table([t("day"), t("cohort"), t("returned"), t("rate")], retention.map((d) => [escape(d.day), n(d.cohort), d.mature ? n(d.d1) : t("pending"), d.mature && d.cohort ? `${n(d.d1 / d.cohort * 100)}%` : t("pending")]))}
      </div>
    </details>
    <script type="application/json" id="dashboard-data">${json(payload)}</script>
    <script src="/assets/echarts.min.js"></script><script type="module" src="/assets/dashboard.js"></script>`;
  }
  const latest = data?.report.latest;
  return `<!doctype html><html lang="${f.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${t("title")}</title><style>${STYLE}</style></head>
<body><div class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><div><h1>${t("title")}</h1><p>${t("subtitle")}</p></div></div>
  <div class="actions">${latest !== undefined ? `<span class="pill"><span class="dot${latest ? "" : " off"}"></span>${escape(t("latest"))} · ${escape(latest ? latest.replace("T", " ").slice(0, 16) : t("none"))}</span>` : ""}
  ${segmented(t("language"), [["zh", "中文", href({ lang: "zh" })], ["en", "EN", href({ lang: "en" })]], f.lang)}
  <a class="button" href="${escape(href({}))}">${escape(t("refresh"))}</a></div></div>
<main><nav class="filters" aria-label="${escape(t("range"))}">
  ${segmented(t("range"), [["7", t("days7"), href({ days: "7" })], ["30", t("days30"), href({ days: "30" })], ["90", t("days90"), href({ days: "90" })]], String(f.days))}
  <div class="chips" role="group" aria-label="${escape(t("region"))}">${regions.map((r) => `<a href="${escape(href({ region: r }))}"${r === f.region ? ' aria-current="true"' : ""}>${escape(t(r))}</a>`).join("")}</div>
  <span class="range">${escape(f.from)} — ${escape(f.to)}</span></nav>
${content}<p class="note">${t("note")}</p></main></body></html>`;
}

const STYLE = `
:root{--bg:#f4f6fa;--surface:#fff;--raised:#f8fafc;--line:#e4e8ef;--text:#111827;--muted:#64748b;--accent:#4f46e5;--accent-soft:#eef2ff;
--c1:#4f46e5;--c2:#0ea5a4;--c3:#f59e0b;--danger:#be123c;--danger-soft:#fff1f2;--ok:#16a34a;--shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--surface:#121826;--raised:#182032;--line:#243046;--text:#e5e9f2;--muted:#8b97ad;--accent:#818cf8;--accent-soft:#1e2340;
--c1:#818cf8;--c2:#2dd4bf;--c3:#fbbf24;--danger:#fda4af;--danger-soft:#2a1520;--ok:#4ade80;--shadow:none}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:14px max(16px,calc((100vw - 1280px)/2));background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}.mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--c1),var(--c2))}
h1{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}.brand p{margin:0;color:var(--muted);font-size:12px}
.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}.dot.off{background:var(--muted)}
.button{padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font-weight:550;font-size:13px}.button:hover{text-decoration:none;filter:brightness(1.08)}
main{max-width:1280px;margin:0 auto;padding:20px 16px 48px}
.filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}.range{margin-left:auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.seg{display:inline-flex;padding:3px;border-radius:10px;background:var(--raised);border:1px solid var(--line)}
.seg a{padding:4px 12px;border-radius:7px;color:var(--muted);font-size:13px;white-space:nowrap}.seg a:hover{text-decoration:none;color:var(--text)}
.seg a[aria-current]{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips a{padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:13px}
.chips a:hover{text-decoration:none;color:var(--text)}.chips a[aria-current]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px}
.stat{display:flex;flex-direction:column;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}
.stat .label{color:var(--muted);font-size:12px}.stat strong{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.stat .sub{color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:16px}
.kpi{position:relative;display:flex;flex-direction:column;padding:16px 18px 0;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;min-height:150px}
.kpi .label{color:var(--muted);font-size:12.5px}.kpi strong{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.25;margin-top:6px;font-variant-numeric:tabular-nums}
.kpi .sub{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.spark{height:46px;margin:6px -18px 0}
.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin-bottom:16px;min-width:0}
.grid .card{margin-bottom:0}.grid{margin-bottom:16px}
.card>header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:8px}
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
@media (max-width:1000px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid,.split{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.kpis,.stats{grid-template-columns:minmax(0,1fr)}.range{margin-left:0}.top{position:static}}
`;
