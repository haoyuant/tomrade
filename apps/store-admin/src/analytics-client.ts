import type * as Echarts from "echarts";
import type { ChartPayload } from "./analytics-page.js";

// Loaded as a classic script from /assets/echarts.min.js before this module runs.
declare const echarts: typeof Echarts;

const source = document.getElementById("dashboard-data");
if (source?.textContent) start(JSON.parse(source.textContent) as ChartPayload);

function start(data: ChartPayload): void {
  const t = (key: keyof ChartPayload["t"]) => data.t[key] ?? key;
  const fmt = new Intl.NumberFormat(data.lang, { maximumFractionDigits: 1 });
  const compact = new Intl.NumberFormat(data.lang, { notation: "compact", maximumFractionDigits: 1 });
  const value = (v: unknown) => (typeof v === "number" ? fmt.format(v) : "—");
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // Every UTC day in a chart's window, so a day without rows shows as a gap rather than vanishing.
  // Each card has its own window; all of them end today.
  const span = (from: string) => {
    const days: string[] = [];
    for (let d = Date.parse(from); d <= Date.parse(data.to); d += 86400000) days.push(new Date(d).toISOString().slice(0, 10));
    const align = <T extends { day: string }>(rows: T[], pick: (row: T) => number | null) => {
      const byDay = new Map(rows.map((r) => [r.day, pick(r)]));
      return days.map((d) => byDay.get(d) ?? null);
    };
    return { days, align };
  };
  // The category is the full day, marked when it is still being counted; the axis shows MM-DD.
  const label = (day: string) => (day === data.to ? `${day} · ${t("today")}` : day);
  const spans = { spark: span(data.from.spark), overview: span(data.from.overview), detail: span(data.from.detail), retention: span(data.from.retention), growth: span(data.from.growth), seo: span(data.from.seo), github: span(data.from.github) };
  const daily = (rows: ChartPayload["daily"], s: ReturnType<typeof span>) => ({
    aai: s.align(rows, (d) => d.aai),
    duration: s.align(rows, (d) => d.duration_ms / 60000),
    uses: s.align(rows, (d) => d.uses)
  });
  const sparks = daily(data.spark, spans.spark);
  const series = daily(data.daily, spans.overview);

  let feature = data.feature;
  const charts = new Map<string, Echarts.ECharts>();

  function render(): void {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const c = { soft: v("--accent-soft"), text: v("--text"), muted: v("--muted"), line: v("--line"), surface: v("--surface"), series: [v("--c1"), v("--c2"), v("--c3")] };
    const tooltip = { backgroundColor: c.surface, borderColor: c.line, textStyle: { color: c.text, fontSize: 12 }, extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12)", confine: true };
    const axis = {
      category: (s: ReturnType<typeof span>) => ({ type: "category" as const, data: s.days.map(label), boundaryGap: true, axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false }, axisLabel: { color: c.muted, hideOverlap: true, formatter: (d: string) => d.slice(5, 10) } }),
      value: { type: "value" as const, splitLine: { lineStyle: { color: c.line, type: "dashed" as const } }, axisLabel: { color: c.muted, formatter: (n: number) => compact.format(n) } }
    };
    const legend = { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: c.muted } };
    const area = (color: string) => ({ color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${color}55` }, { offset: 1, color: `${color}00` }]) });
    // The last day is still being counted.
    const today = { silent: true, itemStyle: { color: c.soft, opacity: 0.9 }, data: [[{ xAxis: label(data.to) }, { xAxis: label(data.to) }]] as never };
    const tooltipTitle = (s: ReturnType<typeof span>, index: number) => `<div style="color:${c.muted};margin-bottom:4px">${escape(label(s.days[index]!))}</div>`;

    const make = (id: string, option: Echarts.EChartsOption) => {
      const el = document.getElementById(id);
      if (!el) return;
      charts.get(id)?.dispose();
      const chart = echarts.init(el, null, { renderer: "svg" });
      chart.setOption({ animationDuration: 400, textStyle: { fontFamily: "inherit" }, ...option });
      charts.set(id, chart);
      return chart;
    };

    document.querySelectorAll<HTMLElement>("[data-spark]").forEach((el, i) => {
      const key = el.dataset.spark as keyof typeof sparks;
      const color = c.series[key === "aai" ? 0 : key === "duration" ? 1 : 2]!;
      el.id ||= `spark-${i}`;
      make(el.id, {
        grid: { left: 0, right: 0, top: 4, bottom: 0 },
        xAxis: { type: "category", show: false, data: spans.spark.days.map(label), boundaryGap: false },
        yAxis: { type: "value", show: false, min: 0 },
        tooltip: { ...tooltip, trigger: "axis", formatter: (p) => { const [first] = p as { dataIndex: number; value: unknown }[]; return first ? `${tooltipTitle(spans.spark, first.dataIndex)}<b>${value(first.value)}</b>` : ""; } },
        series: [{ type: "line", data: sparks[key], smooth: true, symbol: "none", lineStyle: { width: 2, color }, areaStyle: area(color) }]
      });
    });

    make("chart-overview", {
      color: c.series, legend: { ...legend, selectedMode: "single" },
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", valueFormatter: value },
      xAxis: axis.category(spans.overview), yAxis: axis.value,
      series: ([["activeIds", series.aai], ["duration", series.duration], ["uses", series.uses]] as const).map(([name, values], i) => ({
        name: t(name), type: "line", data: values, smooth: true, connectNulls: false, showSymbol: spans.overview.days.length <= 31, symbolSize: 6,
        lineStyle: { width: 2.5 }, areaStyle: area(c.series[i]!), emphasis: { focus: "series" }, ...(i === 0 ? { markArea: today } : {})
      }))
    });

    const top = data.features.slice(0, 10);
    const metricName = t(data.metric === "uses" ? "uses" : "duration");
    make("chart-ranking", {
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: value },
      xAxis: { ...axis.value, splitLine: { show: false }, axisLabel: { show: false } },
      yAxis: { type: "category", inverse: true, data: top.map((d) => d.feature_id), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.text, width: 140, overflow: "truncate" } },
      series: [{
        name: metricName, type: "bar", barMaxWidth: 18, cursor: "pointer",
        data: top.map((d) => ({ value: data.metric === "uses" ? d.uses : d.duration_ms / 60000, itemStyle: { color: d.feature_id === feature ? c.series[0] : `${c.series[0]}88`, borderRadius: [0, 6, 6, 0] } })),
        label: { show: true, position: "right", color: c.muted, formatter: (p: { value: unknown }) => compact.format(Number(p.value)) }
      }]
    })?.on("click", (p) => { if (typeof p.name === "string") choose(p.name, true); });

    const rows = data.days.filter((d) => d.feature_id === feature);
    make("chart-detail", {
      color: [c.series[1], c.series[2]], legend,
      grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", valueFormatter: value },
      xAxis: axis.category(spans.detail),
      yAxis: [axis.value, { ...axis.value, splitLine: { show: false } }],
      series: [
        { name: t("duration"), type: "line", yAxisIndex: 0, data: spans.detail.align(rows, (d) => d.duration_ms / 60000), smooth: true, showSymbol: spans.detail.days.length <= 31, lineStyle: { width: 2.5 }, areaStyle: area(c.series[1]!), markArea: today },
        { name: t("uses"), type: "bar", yAxisIndex: 1, data: spans.detail.align(rows, (d) => d.uses), barMaxWidth: 14, itemStyle: { borderRadius: [4, 4, 0, 0], opacity: 0.85 } }
      ]
    });

    const growth = data.growth ?? [];
    const bar = (name: string, values: (number | null)[]) => ({ name, type: "bar" as const, data: values, barMaxWidth: 10, itemStyle: { borderRadius: [3, 3, 0, 0] } });
    make("chart-growth", {
      color: [c.series[0], c.series[1], `${c.series[1]}66`, c.series[2]], legend,
      grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", valueFormatter: value },
      xAxis: axis.category(spans.growth),
      yAxis: [axis.value, { ...axis.value, splitLine: { show: false } }],
      series: [
        bar(t("newAccounts"), spans.growth.align(growth, (d) => d.accounts)),
        bar(t("siteInstalls"), spans.growth.align(growth, (d) => d.installs)),
        bar(t("updates"), spans.growth.align(growth, (d) => d.updates)),
        { name: t("pageviews"), type: "line", yAxisIndex: 1, data: spans.growth.align(growth, (d) => d.pageviews), smooth: true, showSymbol: spans.growth.days.length <= 31, lineStyle: { width: 2.5 } }
      ]
    });

    make("chart-seo", {
      color: [c.series[0], c.series[2]], legend,
      grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", valueFormatter: value },
      xAxis: axis.category(spans.seo),
      yAxis: [axis.value, { ...axis.value, splitLine: { show: false } }],
      series: [
        bar(t("clicks"), spans.seo.align(data.search, (d) => d.clicks)),
        { name: t("impressions"), type: "line", yAxisIndex: 1, data: spans.seo.align(data.search, (d) => d.impressions), smooth: true, showSymbol: spans.seo.days.length <= 31, lineStyle: { width: 2.5 } }
      ]
    });

    make("chart-github", {
      color: [c.series[0], c.series[1], c.series[2]], legend,
      grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", valueFormatter: value },
      xAxis: axis.category(spans.github),
      yAxis: axis.value,
      series: [
        bar(t("views"), spans.github.align(data.github, (d) => d.views)),
        { name: t("viewUniques"), type: "line", data: spans.github.align(data.github, (d) => d.view_uniques), smooth: true, showSymbol: spans.github.days.length <= 31, lineStyle: { width: 2.5 } },
        bar(t("clones"), spans.github.align(data.github, (d) => d.clones))
      ]
    });

    const retention = new Map(data.retention.map((r) => [r.day, r]));
    make("chart-retention", {
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        ...tooltip, trigger: "axis", axisPointer: { type: "shadow" },
        formatter: (p) => {
          const [first] = p as { dataIndex: number }[];
          if (!first) return "";
          const r = retention.get(spans.retention.days[first.dataIndex]!);
          if (!r) return tooltipTitle(spans.retention, first.dataIndex) + "—";
          const rate = r.mature && r.cohort ? `${fmt.format(r.d1 / r.cohort * 100)}%` : escape(t("pending"));
          return `${tooltipTitle(spans.retention, first.dataIndex)}${escape(t("rate"))}: <b>${rate}</b><br>${escape(t("cohort"))}: ${fmt.format(r.cohort)}<br>${escape(t("returned"))}: ${r.mature ? fmt.format(r.d1) : escape(t("pending"))}`;
        }
      },
      xAxis: axis.category(spans.retention),
      yAxis: { ...axis.value, max: 100, axisLabel: { color: c.muted, formatter: "{value}%" } },
      series: [{
        name: t("rate"), type: "bar", barMaxWidth: 14,
        data: spans.retention.days.map((d) => { const r = retention.get(d); return r?.mature && r.cohort ? r.d1 / r.cohort * 100 : null; }),
        itemStyle: { color: c.series[0], borderRadius: [4, 4, 0, 0] }
      }]
    });
  }

  function choose(next: string, scroll: boolean): void {
    if (!data.detailFeatures.includes(next) && !data.features.some((d) => d.feature_id === next)) return;
    feature = next;
    const pick = document.getElementById("feature-pick") as HTMLSelectElement | null;
    if (pick) pick.value = next;
    document.querySelectorAll<HTMLAnchorElement>("a[data-feature]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.feature === next));
    const url = new URL(location.href);
    url.searchParams.set("feature", next);
    history.replaceState(null, "", url);
    render();
    if (scroll) document.getElementById("chart-detail")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  document.getElementById("feature-pick")?.addEventListener("change", (e) => choose((e.target as HTMLSelectElement).value, false));
  document.querySelectorAll<HTMLAnchorElement>("a[data-feature]").forEach((a) => a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    choose(a.dataset.feature!, true);
  }));
  // Generating takes a minute and the form waits for it: say so, and keep a second click from starting another run.
  document.querySelectorAll<HTMLFormElement>("form.generate").forEach((form) => form.addEventListener("submit", () => {
    const button = form.querySelector("button");
    if (button) { button.disabled = true; button.textContent = t("generating"); }
  }));
  render();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  let frame = 0;
  addEventListener("resize", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => charts.forEach((chart) => chart.resize())); });
}
