import { translator } from "./analytics-messages.js";
import { regions, type DashboardData, type Filters } from "./analytics-data.js";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function renderDashboard(f: Filters, data?: DashboardData, error?: "failed" | "invalid"): string {
  const t = translator(f.lang);
  const n = (value: number) => new Intl.NumberFormat(f.lang, { maximumFractionDigits: 1 }).format(value);
  const select = (name: string, label: string, options: [string, string][], selected: string) => `<label>${escape(label)}<select name="${name}">${options.map(([value, text]) => `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(text)}</option>`).join("")}</select></label>`;
  const table = (heads: string[], rows: string[][]) => `<div class="table"><table><thead><tr>${heads.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const link = (feature: string) => `/?${new URLSearchParams({ days: String(f.days), region: f.region, metric: f.metric, lang: f.lang, feature }).toString()}`;
  const features = [...(data?.report.features ?? [])].sort((a, b) => b[f.metric] - a[f.metric] || a.feature_id.localeCompare(b.feature_id));
  const selected = features.some((row) => row.feature_id === f.feature) ? f.feature : features[0]?.feature_id ?? "";
  const chart = (rows: { day: string; value: number }[], title: string) => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    const width = 800 / f.days;
    return `<figure><figcaption>${escape(title)} · ${escape(f.from)} — ${escape(f.to)}</figcaption><svg viewBox="0 0 800 160" role="img" aria-label="${escape(title)}"><line x1="0" y1="150" x2="800" y2="150" stroke="#cbd5e1"/>${rows.map((r) => {
      const x = (Date.parse(r.day) - Date.parse(f.from)) / 86400000 * width;
      const height = r.value / max * 140;
      return `<rect x="${x + 1}" y="${150 - height}" width="${Math.max(1, width - 2)}" height="${height}" fill="#2563eb"><title>${escape(r.day)}: ${n(r.value)}</title></rect>`;
    }).join("")}</svg></figure>`;
  };
  let content = "";
  if (error) content = `<p role="alert" class="error">${t(error)}</p>`;
  else if (data && !data.report.daily.length && !features.length) content = `<p role="status" class="empty">${t("empty")}</p>`;
  else if (data) {
    const { report } = data;
    const detail = data.days.filter((d) => d.feature_id === selected);
    content = `<div class="cards">${[
      [t("active"), report.daily.some((d) => d.day === f.to) ? n(report.daily.find((d) => d.day === f.to)!.aai) : "—"],
      [t("periodActive"), n(report.totals.aai)], [t("duration"), n(report.totals.duration_ms / 60000)], [t("uses"), n(report.totals.uses)]
      ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("")}</div>
      <p>${t("latest")}: ${escape(report.latest ?? t("none"))}</p>
      <section><h2>${t("overview")}</h2><div class="charts">${chart(report.daily.map((d) => ({ day: d.day, value: d.aai })), t("activeIds"))}${chart(report.daily.map((d) => ({ day: d.day, value: d.duration_ms / 60000 })), t("duration"))}${chart(report.daily.map((d) => ({ day: d.day, value: d.uses })), t("uses"))}</div>
      ${table([t("day"), t("activeIds"), t("duration"), t("uses")], report.daily.map((d) => [escape(d.day), n(d.aai), n(d.duration_ms / 60000), n(d.uses)]))}</section>
      <section><h2>${t("ranking")}</h2>${table([t("feature"), t("duration"), t("uses"), `${t("average")} · ${t("minutes")}`, `${t("average")} · ${t("uses")}`], features.map((d) => [`<a href="${escape(link(d.feature_id))}">${escape(d.feature_id)}</a>`, n(d.duration_ms / 60000), n(d.uses), n(d.duration_ms / 60000 / f.days), n(d.uses / f.days)]))}</section>
      <section><h2>${t("detail")} · ${escape(selected)}</h2>${detail.length ? `<div class="charts">${chart(detail.map((d) => ({ day: d.day, value: d.duration_ms / 60000 })), t("duration"))}${chart(detail.map((d) => ({ day: d.day, value: d.uses })), t("uses"))}</div>${table([t("day"), t("duration"), t("uses")], detail.map((d) => [escape(d.day), n(d.duration_ms / 60000), n(d.uses)]))}` : `<p>${t("empty")}</p>`}</section>
      <section><h2>${t("retention")}</h2>${table([t("day"), t("cohort"), t("returned"), t("rate")], report.retention.map((d) => {
        const mature = Date.parse(d.day) + 86400000 < Date.parse(f.to);
        return [escape(d.day), n(d.cohort), mature ? n(d.d1) : t("pending"), mature && d.cohort ? `${n(d.d1 / d.cohort * 100)}%` : t("pending")];
      }))}</section>`;
  }
  return `<!doctype html><html lang="${f.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t("title")}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#182437;font:15px system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:36px 24px}h1{margin:0;font-size:30px}h2{font-size:19px}p,figcaption{color:#526379}form,.cards,.charts{display:flex;gap:16px;flex-wrap:wrap}form,section{background:white;border:1px solid #dfe5ed;border-radius:12px;padding:20px;margin:24px 0}label{display:grid;gap:8px;font-size:13px}select,button{padding:9px;border:1px solid #b9c5d4;border-radius:6px;background:white;color:inherit}button{align-self:end;background:#1d4ed8;color:white;cursor:pointer}.cards article{flex:1;min-width:190px;background:white;border:1px solid #dfe5ed;border-radius:10px;padding:20px}.cards span{color:#526379}.cards strong{display:block;font-size:30px;margin-top:12px}figure{margin:10px 0;flex:1;min-width:240px}svg{width:100%;height:auto}figcaption{font-size:12px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #e7edf4;white-space:nowrap}th{font-size:12px;color:#526379}a{color:#1d4ed8}.error{padding:24px;background:#fff1f2;color:#9f1239}.empty{padding:40px;text-align:center}
  </style></head><body><main><header><h1>${t("title")}</h1><p>${t("subtitle")}</p></header><form method="get" action="/">
  ${select("days", t("range"), [["7", t("days7")], ["30", t("days30")], ["90", t("days90")]], String(f.days))}
  ${select("region", t("region"), regions.map((r) => [r, t(r)]), f.region)}
  ${select("metric", t("metric"), [["duration_ms", t("duration")], ["uses", t("uses")]], f.metric)}
  ${select("feature", t("feature"), features.map((d) => [d.feature_id, d.feature_id]), selected)}
  ${select("lang", t("language"), [["zh", "中文"], ["en", "English"]], f.lang)}<button type="submit">${t("apply")}</button></form>
  ${content}<p>${t("note")}</p></main></body></html>`;
}
