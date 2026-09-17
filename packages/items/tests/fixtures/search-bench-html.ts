/**
 * The HTML report: a self-contained page (Paper theme, Charter for prose,
 * system sans for figures) that draws the run's numbers as SVG. Series colours
 * follow the engine, never its rank; every chart has a table twin and a hover
 * readout; a size/limit filter row scopes the accuracy section.
 */
import type { BenchReport } from "./search-bench-report.js";

const CSS = String.raw`
:root {
  --page: #faf9f5; --surface: #fffefb; --surface-warm: #f1efe6; --border: #e8e6dc; --border-soft: #efede4;
  --ink: #24231f; --ink-2: #5c5a52; --muted: #8a877d; --grid: #ebe9e0; --axis: #d3d0c4;
  --accent: #1b365d; --accent-on: #faf9f5;
  --s-grep: #eb6834; --s-instr: #1baf7a; --s-phrase: #eda100; --s-fts: #2a78d6; --s-off: #a9a598; --s-on: #2a78d6;
  --ramp-1: #cde2fb; --ramp-2: #9ec5f4; --ramp-3: #6da7ec; --ramp-4: #3987e5; --ramp-5: #256abf; --ramp-6: #184f95;
  --font-prose: Charter, Georgia, Palatino, "Times New Roman", serif;
  --font-ui: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page: #30302e; --surface: #363533; --surface-warm: #3d3c39; --border: #4a4945; --border-soft: #41403c;
    --ink: #f2f0ea; --ink-2: #c3c2b7; --muted: #949188; --grid: #444340; --axis: #55534e;
    --accent: #7aa7d8; --accent-on: #141413;
    --s-grep: #d95926; --s-instr: #199e70; --s-phrase: #c98500; --s-fts: #3987e5; --s-off: #7e7b71; --s-on: #3987e5;
    --ramp-1: #1e3550; --ramp-2: #1c4a7c; --ramp-3: #1c5cab; --ramp-4: #2a78d6; --ramp-5: #5598e7; --ramp-6: #86b6ef;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --page: #30302e; --surface: #363533; --surface-warm: #3d3c39; --border: #4a4945; --border-soft: #41403c;
  --ink: #f2f0ea; --ink-2: #c3c2b7; --muted: #949188; --grid: #444340; --axis: #55534e;
  --accent: #7aa7d8; --accent-on: #141413;
  --s-grep: #d95926; --s-instr: #199e70; --s-phrase: #c98500; --s-fts: #3987e5; --s-off: #7e7b71; --s-on: #3987e5;
  --ramp-1: #1e3550; --ramp-2: #1c4a7c; --ramp-3: #1c5cab; --ramp-4: #2a78d6; --ramp-5: #5598e7; --ramp-6: #86b6ef;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font-family: var(--font-prose); font-size: 16px; line-height: 1.55; }
.wrap { max-width: 1040px; margin: 0 auto; padding-block: 40px 64px; padding-inline: 16px; }
header h1 { font-family: var(--font-prose); font-weight: 400; font-size: clamp(30px, 4.5vw, 42px); line-height: 1.1; margin: 0 0 10px; letter-spacing: -0.01em; text-wrap: balance; }
header p.lede { margin: 0; max-width: 62ch; color: var(--ink-2); font-size: 17px; }
.env { margin: 14px 0 0; font-family: var(--font-ui); font-size: 12.5px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 18px; }
.env b { font-weight: 500; color: var(--ink-2); }
section { margin-top: 44px; }
section > h2 { font-family: var(--font-prose); font-weight: 400; font-size: 25px; margin: 0 0 4px; letter-spacing: -0.005em; text-wrap: balance; }
section > p.sub { margin: 0 0 18px; color: var(--ink-2); max-width: 68ch; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 24px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px 12px; font-family: var(--font-ui); }
.kpi .label { font-size: 12.5px; color: var(--ink-2); letter-spacing: 0.01em; }
.kpi .value { font-size: 30px; font-weight: 600; line-height: 1.15; margin-top: 6px; }
.kpi .value small { font-size: 15px; font-weight: 500; color: var(--ink-2); margin-left: 4px; }
.kpi .delta { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.kpi .delta b { color: var(--ink-2); font-weight: 500; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 16px 18px 14px; margin-top: 14px; }
.card h3 { font-family: var(--font-ui); font-weight: 600; font-size: 14.5px; margin: 0; }
.card .note { font-family: var(--font-ui); font-size: 12.5px; color: var(--muted); margin: 3px 0 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-family: var(--font-ui); font-size: 12.5px; color: var(--ink-2); margin: 0 0 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.legend i.dot { border-radius: 50%; }
.legend i.ring { border-radius: 50%; background: transparent !important; border: 2px solid currentColor; width: 8px; height: 8px; }
.legend i.line { width: 14px; height: 2px; border-radius: 1px; }
.panels { display: flex; flex-wrap: wrap; gap: 12px; }
.panel { flex: 1 1 280px; min-width: 0; }
.panel h4 { font-family: var(--font-ui); font-weight: 500; font-size: 12.5px; color: var(--ink-2); margin: 0 0 4px; }
svg { display: block; width: 100%; height: auto; font-family: var(--font-ui); }
svg text { fill: var(--ink-2); font-size: 11.5px; }
svg text.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg text.val { fill: var(--ink); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
svg text.row { fill: var(--ink); font-size: 12px; }
svg text.err { fill: var(--muted); font-size: 11px; font-style: italic; }
svg line.grid { stroke: var(--grid); stroke-width: 1; shape-rendering: crispEdges; }
svg line.axis { stroke: var(--axis); stroke-width: 1; shape-rendering: crispEdges; }
svg .mark { cursor: default; }
svg .mark:focus { outline: none; }
svg .mark:focus-visible .ring, svg .mark:hover .ring { stroke: var(--accent); stroke-width: 2; }
svg .hit { fill: transparent; }
.grep { color: var(--s-grep); } .instr { color: var(--s-instr); } .phrase { color: var(--s-phrase); } .fts { color: var(--s-fts); } .off { color: var(--s-off); } .on { color: var(--s-on); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; padding: 12px 0 4px; margin-top: 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); font-family: var(--font-ui); font-size: 13px; position: sticky; top: env(safe-area-inset-top, 0px); background: var(--page); z-index: 2; }
.filters .group { display: inline-flex; align-items: center; gap: 8px; }
.filters .group > span { color: var(--ink-2); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--surface); }
.seg button { font: inherit; font-family: var(--font-ui); font-size: 13px; padding: 5px 12px; border: 0; background: transparent; color: var(--ink-2); cursor: pointer; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-on); }
.seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
details.tbl { margin-top: 10px; font-family: var(--font-ui); font-size: 12.5px; }
details.tbl summary { cursor: pointer; color: var(--ink-2); list-style: none; display: inline-flex; align-items: center; gap: 6px; padding: 2px 0; }
details.tbl summary::-webkit-details-marker { display: none; }
details.tbl summary::before { content: "▸"; font-size: 11px; color: var(--muted); }
details.tbl[open] summary::before { content: "▾"; }
.tscroll { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-family: var(--font-ui); font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 5px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
th { font-weight: 500; color: var(--ink-2); }
th:first-child, td:first-child { text-align: left; }
td.k { color: var(--ink-2); }
td.heat { color: var(--ink); }
.notes { color: var(--ink-2); font-size: 15px; }
.notes li { margin: 6px 0; }
.notes code, .kpi code { font-family: var(--font-mono); font-size: 0.85em; background: var(--surface-warm); padding: 1px 5px; border-radius: 3px; }
#tip { position: fixed; pointer-events: none; z-index: 10; background: var(--ink); color: var(--page); font-family: var(--font-ui); font-size: 12px; line-height: 1.4; padding: 7px 10px; border-radius: 5px; max-width: 260px; box-shadow: 0 4px 16px rgba(0,0,0,0.18); }
#tip[hidden] { display: none; }
#tip b { font-weight: 600; font-size: 13px; }
#tip .k { opacity: 0.75; }
#tip .row { display: flex; gap: 8px; align-items: baseline; }
#tip .row i { display: inline-block; width: 12px; height: 2px; border-radius: 1px; align-self: center; }
@media (max-width: 560px) { .kpi .value { font-size: 26px; } .card { padding: 14px 12px 12px; } }
@media (prefers-reduced-motion: no-preference) { .seg button { transition: background 120ms; } }
`;

const SCRIPT = String.raw`
(function () {
  var D = window.__BENCH__;
  var sizes = D.sizes;
  var ENGINES = [
    { id: "grep", name: "grep（main）", cls: "grep" },
    { id: "instr", name: "instr（无索引）", cls: "instr" },
    { id: "phrase", name: "FTS5 短语", cls: "phrase" },
    { id: "fts", name: "FTS5 + BM25", cls: "fts" }
  ].filter(function (e) { return sizes[0].overall.all[e.id]; });
  var LAT_ROWS = [
    { key: "grep", name: "grep（main）", cls: "grep", shape: "dot" },
    { key: "instr", name: "instr（无索引）", cls: "instr", shape: "dot" },
    { key: "fts", name: "FTS5 + BM25", cls: "fts", shape: "dot" },
    { key: "phrase", name: "FTS5 短语", cls: "phrase", shape: "dot" },
    { key: "svc-old", name: "旧 list_items 端到端", cls: "grep", shape: "ring" },
    { key: "svc-new", name: "新 list_items 端到端", cls: "fts", shape: "ring" }
  ];
  var limitKeys = D.limits.map(function (l) { return l === null ? "all" : String(l); });
  var smallest = D.limits.filter(function (l) { return l !== null; }).sort(function (a, b) { return a - b; })[0];
  if (smallest !== undefined) {
    LAT_ROWS.push({ key: "instr@" + smallest, name: "instr，limit " + smallest, cls: "instr", shape: "sq" });
    LAT_ROWS.push({ key: "fts@" + smallest, name: "FTS5，limit " + smallest, cls: "fts", shape: "sq" });
    LAT_ROWS.push({ key: "svc-new@" + smallest, name: "新 list_items，limit " + smallest, cls: "fts", shape: "sqring" });
  }

  function fmtN(n) { return n >= 1000 ? (n / 1000) + "k" : String(n); }
  function fmtMs(x) { if (!isFinite(x)) return "n/a"; return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + " ms"; }
  function fmtPct(x) { return isFinite(x) ? (x * 100).toFixed(0) + "%" : "n/a"; }
  function fmtInt(x) { return isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a"; }
  function fmtMB(b) { return (b / 1048576).toFixed(1) + " MB"; }
  function fmtX(x) { return isFinite(x) ? x.toFixed(x >= 10 ? 0 : 1) + "×" : "n/a"; }
  function limitName(k) { return k === "all" ? "不限" : "limit " + k; }

  var SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else if (k === "html") e.innerHTML = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function sv(tag, attrs, children) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  var tip = document.getElementById("tip");
  function showTip(rows, x, y) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    rows.forEach(function (r) {
      if (typeof r === "string") { tip.appendChild(el("div", { text: r })); return; }
      var row = el("div", { class: "row" });
      if (r.cls) { var i = el("i", { class: r.cls }); i.style.background = "currentColor"; row.appendChild(i); }
      row.appendChild(el("b", { text: r.v }));
      row.appendChild(el("span", { class: "k", text: r.k }));
      tip.appendChild(row);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8), top = y - h - 12;
    if (top < 8) top = y + 16;
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }
  function hideTip() { tip.hidden = true; }
  function attachTip(node, rowsFn) {
    node.classList.add("mark");
    node.setAttribute("tabindex", "0");
    node.addEventListener("pointermove", function (ev) { showTip(rowsFn(), ev.clientX, ev.clientY); });
    node.addEventListener("pointerleave", hideTip);
    node.addEventListener("focus", function () { var b = node.getBoundingClientRect(); showTip(rowsFn(), b.left + b.width / 2, b.top); });
    node.addEventListener("blur", hideTip);
  }

  function table(head, rows) {
    var t = el("table");
    var tr = el("tr"); head.forEach(function (h) { tr.appendChild(el("th", { text: h })); }); t.appendChild(el("thead", null, [tr]));
    var tb = el("tbody");
    rows.forEach(function (r) { var x = el("tr"); r.forEach(function (c, i) { x.appendChild(el("td", { class: i === 0 ? "k" : "", text: c })); }); tb.appendChild(x); });
    t.appendChild(tb);
    return el("details", { class: "tbl" }, [el("summary", { text: "表格" }), el("div", { class: "tscroll" }, [t])]);
  }

  function logScale(min, max, x0, x1) {
    var lmin = Math.log10(min), lmax = Math.log10(max);
    return function (v) { return x0 + (Math.log10(Math.max(v, min)) - lmin) / (lmax - lmin) * (x1 - x0); };
  }
  function linScale(min, max, x0, x1) { return function (v) { return x0 + (v - min) / (max - min) * (x1 - x0); }; }
  function logTicks(min, max) { var out = []; for (var p = Math.ceil(Math.log10(min)); p <= Math.floor(Math.log10(max)); p++) out.push(Math.pow(10, p)); return out; }
  function marker(shape, cx, cy, cls) {
    var g = sv("g", { class: cls });
    var ring = shape === "ring" || shape === "sqring";
    var m;
    if (shape === "sq" || shape === "sqring") m = sv("rect", { x: cx - 5, y: cy - 5, width: 10, height: 10, rx: 1.5, fill: ring ? "var(--surface)" : "currentColor", stroke: "currentColor", "stroke-width": ring ? 2 : 0 });
    else m = sv("circle", { cx: cx, cy: cy, r: 5, fill: ring ? "var(--surface)" : "currentColor", stroke: "currentColor", "stroke-width": ring ? 2 : 0 });
    var halo = sv("circle", { class: "ring", cx: cx, cy: cy, r: 7.5, fill: "none", stroke: "var(--surface)", "stroke-width": 2 });
    g.appendChild(halo); g.appendChild(m);
    return g;
  }

  // ---- KPI row ----
  (function kpis() {
    var big = sizes[sizes.length - 1];
    var wrap = document.getElementById("kpis");
    var lat = big.latency;
    var grepP50 = lat.grep.p50, ftsP50 = lat.fts.p50;
    var lim = smallest === undefined ? "all" : String(smallest);
    var oa = big.overall.all, ol = big.overall[lim];
    function kpi(label, value, unit, delta) {
      var v = el("div", { class: "value" }, [value]); if (unit) v.appendChild(el("small", { text: unit }));
      var d = el("div", { class: "delta", html: delta });
      wrap.appendChild(el("div", { class: "kpi" }, [el("div", { class: "label", text: label }), v, d]));
    }
    kpi("查询 p50 延迟，" + fmtN(big.n) + " 条", fmtMs(ftsP50).replace(" ms", ""), "ms", "FTS5，对比 grep 的 <b>" + fmtMs(grepP50) + "</b>，快 <b>" + fmtX(grepP50 / ftsP50) + "</b>");
    kpi("主题查询召回，不限 limit", fmtPct(oa.fts.recall), "", "FTS5，对比 grep 的 <b>" + fmtPct(oa.grep.recall) + "</b>；其余是同义改写，词法搜索到不了");
    kpi("每次查询读回的 token，" + limitName(lim), fmtInt(ol.fts.tokens), "", "FTS5 在召回 <b>" + fmtPct(ol.fts.recall) + "</b> 时；grep 不限 limit 读 <b>" + fmtInt(oa.grep.tokens) + "</b>，召回 " + fmtPct(oa.grep.recall));
    kpi("库文件体积", fmtX(big.storage.on / big.storage.off), "", "开索引 <b>" + fmtMB(big.storage.on) + "</b>，关 <b>" + fmtMB(big.storage.off) + "</b>；items_fts 约为正文的 " + (big.storage.ftsTables ? (big.storage.ftsTables / (big.n * big.avgBytes)).toFixed(1) + "×" : "n/a"));
  })();

  // ---- Latency dot plot, small multiples by size ----
  (function latency() {
    var host = document.getElementById("latency");
    var minMs = 0.03, maxMs = 1000;
    var W = 340, left = 150, right = 30, rowH = 26, top = 22;
    var H = top + LAT_ROWS.length * rowH + 40;
    var panels = el("div", { class: "panels" });
    var tableRows = [];
    sizes.forEach(function (s) {
      var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": fmtN(s.n) + " 条时各引擎的查询延迟" });
      var x = logScale(minMs, maxMs, left, W - right);
      logTicks(minMs * 3, maxMs).forEach(function (t) {
        svg.appendChild(sv("line", { class: "grid", x1: x(t), x2: x(t), y1: top - 6, y2: H - 36 }));
        svg.appendChild(sv("text", { class: "tick", x: x(t), y: H - 22, "text-anchor": "middle", text: t >= 1 ? String(t) : t.toFixed(1) }));
      });
      svg.appendChild(sv("text", { class: "tick", x: W - right, y: H - 6, "text-anchor": "end", text: "ms，对数轴 →" }));
      svg.appendChild(sv("line", { class: "axis", x1: left - 6, x2: W - right, y1: H - 36, y2: H - 36 }));
      LAT_ROWS.forEach(function (r, i) {
        var l = s.latency[r.key];
        var cy = top + i * rowH + rowH / 2;
        svg.appendChild(sv("text", { class: "row", x: left - 10, y: cy + 4, "text-anchor": "end", text: r.name }));
        if (!l) return;
        var label = r.name + (l.limit === null ? "" : "");
        if (l.error) {
          svg.appendChild(sv("text", { class: "err", x: left, y: cy + 4, text: "报错：" + l.error }));
          tableRows.push([fmtN(s.n), label, "报错", "", "", l.error]);
          return;
        }
        var g = sv("g", { class: r.cls });
        g.appendChild(sv("line", { x1: x(l.p50), x2: x(l.p95), y1: cy, y2: cy, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", opacity: 0.45 }));
        g.appendChild(marker(r.shape, x(l.p50), cy, r.cls));
        if (r.key === "grep" || r.key === "fts") {
          var xr = x(Math.max(l.p50, l.p95)), flip = xr > left + (W - left - right) * 0.62;
          g.appendChild(sv("text", { class: "val", x: flip ? x(l.p50) - 10 : xr + 10, y: cy + 4, "text-anchor": flip ? "end" : "start", text: fmtMs(l.p50) }));
        }
        var hit = sv("rect", { class: "hit", x: left - 6, y: cy - rowH / 2, width: W - left - right + 6, height: rowH });
        g.appendChild(hit);
        attachTip(g, function () { return [fmtN(s.n) + " 条 · " + r.name, { v: fmtMs(l.p50), k: "p50", cls: r.cls }, { v: fmtMs(l.p95), k: "p95" }, { v: fmtMs(l.max), k: "max" }, { v: String(l.queries), k: "条查询" }]; });
        svg.appendChild(g);
        tableRows.push([fmtN(s.n), label, fmtMs(l.p50), fmtMs(l.p95), fmtMs(l.max), ""]);
      });
      panels.appendChild(el("div", { class: "panel" }, [el("h4", { text: fmtN(s.n) + " 条工单" }), svg]));
    });
    host.appendChild(panels);
    host.appendChild(table(["规模", "引擎", "p50", "p95", "max", ""], tableRows));
  })();

  // ---- Storage bars ----
  (function storage() {
    var host = document.getElementById("storage");
    var W = 700, left = 70, right = 90, rowH = 44, top = 8;
    var H = top + sizes.length * rowH + 8;
    var max = Math.max.apply(null, sizes.map(function (s) { return s.storage.on; }));
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "开关索引的库文件体积" });
    var x = linScale(0, max * 1.05, left, W - right);
    var rows = [];
    sizes.forEach(function (s, i) {
      var y0 = top + i * rowH;
      svg.appendChild(sv("text", { class: "row", x: left - 10, y: y0 + rowH / 2 + 4, "text-anchor": "end", text: fmtN(s.n) + " 条" }));
      [["off", s.storage.off, "关索引"], ["on", s.storage.on, "开索引"]].forEach(function (b, j) {
        var y = y0 + 4 + j * 18;
        var g = sv("g", { class: b[0] });
        var w = Math.max(2, x(b[1]) - left);
        g.appendChild(sv("path", { d: "M" + left + "," + y + "h" + (w - 4) + "a4,4 0 0 1 4,4v8a4,4 0 0 1 -4,4h" + (-(w - 4)) + "z", fill: "currentColor" }));
        g.appendChild(sv("text", { class: "val", x: left + w + 8, y: y + 12, text: fmtMB(b[1]) + (j === 1 ? "（" + fmtX(s.storage.on / s.storage.off) + "）" : "") }));
        g.appendChild(sv("rect", { class: "hit", x: left, y: y - 1, width: W - left - right, height: 18 }));
        attachTip(g, function () { return [fmtN(s.n) + " 条 · " + b[2], { v: fmtMB(b[1]), k: "库文件", cls: b[0] }, s.storage.ftsTables && j === 1 ? { v: fmtMB(s.storage.ftsTables), k: "其中 items_fts" } : { v: fmtMB(s.n * s.avgBytes), k: "标题+正文文本" }]; });
        svg.appendChild(g);
      });
      rows.push([fmtN(s.n), fmtMB(s.storage.off), fmtMB(s.storage.on), s.storage.ftsTables ? fmtMB(s.storage.ftsTables) : "n/a", fmtMB(s.n * s.avgBytes), fmtX(s.storage.on / s.storage.off)]);
    });
    host.appendChild(svg);
    host.appendChild(table(["规模", "关索引", "开索引", "其中 items_fts", "标题+正文", "倍数"], rows));
  })();

  // ---- Write cost table ----
  (function writes() {
    var host = document.getElementById("writes");
    var rows = sizes.map(function (s) {
      var w = s.writes;
      return [fmtN(s.n), fmtMs(w.insertOff / s.n * 1000).replace(" ms", " µs"), fmtMs(w.insertOn / s.n * 1000).replace(" ms", " µs"), fmtMs(w.createOff / w.createK), fmtMs(w.createOn / w.createK), fmtMs(w.updateOff / w.updateK * 1000).replace(" ms", " µs"), fmtMs(w.updateOn / w.updateK * 1000).replace(" ms", " µs"), fmtMs(w.deleteOff / w.updateK * 1000).replace(" ms", " µs"), fmtMs(w.deleteOn / w.updateK * 1000).replace(" ms", " µs"), fmtMs(w.rebuildOn)];
    });
    var t = table(["规模", "批量插入/行 关", "开", "items.create/次 关", "开", "更新/行 关", "开", "删除/行 关", "开", "重建索引"], rows);
    t.setAttribute("open", "");
    host.appendChild(t);
  })();

  // ---- Filters ----
  var state = { size: sizes.length - 1, limit: limitKeys[limitKeys.length - 1] };
  try { var saved = JSON.parse(localStorage.getItem("bench-filters") || "null"); if (saved && sizes[saved.size] && limitKeys.indexOf(saved.limit) >= 0) state = saved; } catch (e) {}
  function seg(id, options, current, onPick) {
    var s = document.getElementById(id);
    options.forEach(function (o) {
      var b = el("button", { type: "button", id: id + "-" + o.value, "aria-pressed": String(o.value === current), text: o.label });
      b.addEventListener("click", function () { onPick(o.value); Array.prototype.forEach.call(s.children, function (c) { c.setAttribute("aria-pressed", String(c === b)); }); });
      s.appendChild(b);
    });
  }
  seg("seg-size", sizes.map(function (s, i) { return { value: i, label: fmtN(s.n) + " 条" }; }), state.size, function (v) { state.size = v; renderScoped(); });
  seg("seg-limit", limitKeys.map(function (k) { return { value: k, label: limitName(k) }; }), state.limit, function (v) { state.limit = v; renderScoped(); });

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- Recall vs tokens (Pareto) ----
  function pareto() {
    var host = document.getElementById("pareto"); clear(host);
    var s = sizes[state.size];
    var W = 700, left = 52, right = 24, top = 16, bottom = 40, H = 300;
    var PE = ENGINES.filter(function (e) { return e.id !== "phrase"; });
    var vals = []; PE.forEach(function (e) { limitKeys.forEach(function (k) { vals.push(s.overall[k][e.id].tokens); }); });
    var tmin = Math.pow(10, Math.floor(Math.log10(Math.max(50, Math.min.apply(null, vals)) ) )), tmax = Math.pow(10, Math.ceil(Math.log10(Math.max.apply(null, vals) * 1.2)));
    var x = logScale(tmin, tmax, left, W - right), y = linScale(0, 1, H - bottom, top);
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "召回率对读回 token 数" });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      svg.appendChild(sv("line", { class: "grid", x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      svg.appendChild(sv("text", { class: "tick", x: left - 8, y: y(v) + 4, "text-anchor": "end", text: fmtPct(v) }));
    });
    logTicks(tmin, tmax).forEach(function (t) {
      svg.appendChild(sv("line", { class: "grid", x1: x(t), x2: x(t), y1: top, y2: H - bottom }));
      svg.appendChild(sv("text", { class: "tick", x: x(t), y: H - bottom + 16, "text-anchor": "middle", text: fmtInt(t) }));
    });
    svg.appendChild(sv("text", { class: "tick", x: W - right, y: H - 6, "text-anchor": "end", text: "每次查询读回的 token（估算，对数轴）→" }));
    svg.appendChild(sv("line", { class: "axis", x1: left, x2: W - right, y1: H - bottom, y2: H - bottom }));
    var rows = [];
    PE.forEach(function (e) {
      var pts = limitKeys.map(function (k) { var a = s.overall[k][e.id]; return { k: k, a: a, x: x(a.tokens), y: y(a.recall) }; });
      var g = sv("g", { class: e.cls });
      var d = pts.map(function (p, i) { return (i ? "L" : "M") + p.x.toFixed(1) + "," + p.y.toFixed(1); }).join("");
      g.appendChild(sv("path", { d: d, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.7 }));
      pts.forEach(function (p) {
        var selected = p.k === state.limit;
        var m = marker("dot", p.x, p.y, e.cls);
        m.setAttribute("opacity", selected ? "1" : "0.55");
        var lbl = selected ? sv("text", { class: "val", x: p.x, y: p.y - 11, "text-anchor": "middle", text: e.name + "，" + limitName(p.k) }) : null;
        var hit = sv("circle", { class: "hit", cx: p.x, cy: p.y, r: 14 });
        var grp = sv("g", null, [m, lbl, hit]);
        attachTip(grp, function () { return [e.name + " · " + limitName(p.k) + " · " + fmtN(s.n) + " 条", { v: fmtPct(p.a.recall), k: "召回", cls: e.cls }, { v: fmtInt(p.a.tokens), k: "token / 查询" }, { v: fmtPct(p.a.precision), k: "精确率" }, { v: p.a.mrr.toFixed(2), k: "MRR" }, { v: p.a.results.toFixed(1), k: "返回行数" }]; });
        g.appendChild(grp);
        rows.push([e.name, limitName(p.k), fmtPct(p.a.recall), fmtPct(p.a.precision), p.a.mrr.toFixed(2), p.a.results.toFixed(1), fmtInt(p.a.tokens), fmtInt(p.a.tokensToFirstHit)]);
      });
      svg.appendChild(g);
    });
    host.appendChild(svg);
    host.appendChild(table(["引擎", "limit", "召回", "精确率", "MRR", "返回行数", "token / 查询", "读到首个相关项的 token"], rows));
  }

  // ---- Metric grouped columns ----
  function metrics() {
    var host = document.getElementById("metrics"); clear(host);
    var s = sizes[state.size];
    var METRICS = [["recall", "召回"], ["precision", "精确率"], ["mrr", "MRR"], ["r5", "前 5 条命中"]];
    var W = 700, left = 48, right = 12, top = 20, bottom = 30, H = 260;
    var y = linScale(0, 1, H - bottom, top);
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "召回、精确率、MRR、前五命中" });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      svg.appendChild(sv("line", { class: "grid", x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      svg.appendChild(sv("text", { class: "tick", x: left - 8, y: y(v) + 4, "text-anchor": "end", text: fmtPct(v) }));
    });
    var groupW = (W - left - right) / METRICS.length, barW = 22, gap = 2;
    var rows = [];
    METRICS.forEach(function (m, gi) {
      var gx = left + gi * groupW + groupW / 2;
      var total = ENGINES.length * barW + (ENGINES.length - 1) * gap;
      svg.appendChild(sv("text", { class: "row", x: gx, y: H - 10, "text-anchor": "middle", text: m[1] }));
      var row = [m[1]];
      ENGINES.forEach(function (e, ei) {
        var a = s.overall[state.limit][e.id];
        var v = a[m[0]]; if (!isFinite(v)) v = 0;
        var bx = gx - total / 2 + ei * (barW + gap);
        var h = Math.max(0, (H - bottom) - y(v));
        var g = sv("g", { class: e.cls });
        var r = Math.min(4, h);
        g.appendChild(sv("path", { d: "M" + bx + "," + (H - bottom) + "v" + (-(h - r)) + "a" + r + "," + r + " 0 0 1 " + r + "," + (-r) + "h" + (barW - 2 * r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r + "v" + (h - r) + "z", fill: "currentColor" }));
        if (e.id !== "instr") g.appendChild(sv("text", { class: "val", x: bx + barW / 2, y: y(v) - 5, "text-anchor": "middle", text: m[0] === "mrr" ? v.toFixed(2) : fmtPct(v) }));
        g.appendChild(sv("rect", { class: "hit", x: bx - 1, y: top, width: barW + 2, height: H - bottom - top }));
        attachTip(g, function () { return [e.name + " · " + limitName(state.limit) + " · " + fmtN(s.n) + " 条", { v: m[0] === "mrr" ? v.toFixed(2) : fmtPct(v), k: m[1], cls: e.cls }, { v: fmtInt(a.tokens), k: "token / 查询" }, { v: a.results.toFixed(1), k: "返回行数" }]; });
        svg.appendChild(g);
        row.push(m[0] === "mrr" ? v.toFixed(2) : fmtPct(v));
      });
      rows.push(row);
    });
    svg.appendChild(sv("line", { class: "axis", x1: left, x2: W - right, y1: H - bottom, y2: H - bottom }));
    host.appendChild(svg);
    host.appendChild(table(["指标"].concat(ENGINES.map(function (e) { return e.name; })), rows));
  }

  // ---- Per-category recall, horizontal grouped bars ----
  function categories() {
    var host = document.getElementById("categories"); clear(host);
    var s = sizes[state.size];
    var byCat = s.accuracy[state.limit];
    var cats = Object.keys(byCat);
    var SHOW = [ENGINES[0], ENGINES[2]];
    var W = 700, left = 118, right = 60, top = 8, rowH = 38, bottom = 26;
    var H = top + cats.length * rowH + bottom;
    var x = linScale(0, 1, left, W - right);
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "各查询类别的召回率" });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      svg.appendChild(sv("line", { class: "grid", x1: x(v), x2: x(v), y1: top, y2: H - bottom }));
      svg.appendChild(sv("text", { class: "tick", x: x(v), y: H - 8, "text-anchor": "middle", text: fmtPct(v) }));
    });
    var rows = [];
    cats.forEach(function (c, i) {
      var y0 = top + i * rowH;
      var q = byCat[c].grep.queries;
      svg.appendChild(sv("text", { class: "row", x: left - 10, y: y0 + rowH / 2 + 1, "text-anchor": "end", text: c }));
      svg.appendChild(sv("text", { class: "tick", x: left - 10, y: y0 + rowH / 2 + 13, "text-anchor": "end", text: q + " 条查询" }));
      var row = [c, String(q)];
      if (byCat[c].phrase) row.push(fmtPct(byCat[c].phrase.recall), byCat[c].phrase.mrr.toFixed(2));
      SHOW.forEach(function (e, j) {
        var a = byCat[c][e.id];
        var yb = y0 + 4 + j * 15;
        var w = Math.max(0, x(a.recall) - left);
        var g = sv("g", { class: e.cls });
        var r = Math.min(4, w);
        g.appendChild(sv("path", { d: "M" + left + "," + yb + "h" + (w - r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r + "v" + (13 - 2 * r) + "a" + r + "," + r + " 0 0 1 " + (-r) + "," + r + "h" + (-(w - r)) + "z", fill: "currentColor" }));
        if (e.id === "fts" || a.recall === 0) g.appendChild(sv("text", { class: "val", x: left + w + 6, y: yb + 10.5, text: fmtPct(a.recall) }));
        g.appendChild(sv("rect", { class: "hit", x: left, y: yb - 1, width: W - left - right, height: 15 }));
        attachTip(g, function () { return [c + " · " + e.name + " · " + limitName(state.limit), { v: fmtPct(a.recall), k: "召回", cls: e.cls }, { v: fmtPct(a.precision), k: "精确率" }, { v: a.mrr.toFixed(2), k: "MRR" }, { v: a.results.toFixed(1), k: "返回行数" }, { v: fmtInt(a.tokens), k: "token / 查询" }, { v: a.noHit + " / " + a.queries, k: "零命中的查询" }]; });
        svg.appendChild(g);
        row.push(fmtPct(a.recall), a.mrr.toFixed(2), fmtInt(a.tokens));
      });
      rows.push(row);
    });
    svg.appendChild(sv("line", { class: "axis", x1: left, x2: left, y1: top, y2: H - bottom }));
    host.appendChild(svg);
    host.appendChild(table(["类别", "查询数"].concat(byCat[cats[0]].phrase ? ["短语 召回", "短语 MRR"] : []).concat(["grep 召回", "grep MRR", "grep token", "FTS 召回", "FTS MRR", "FTS token"]), rows));
  }

  // ---- Variant heat table ----
  function variants() {
    var host = document.getElementById("variants"); clear(host);
    var s = sizes[state.size];
    var cols = [["phrase", "词相邻在标题"], ["reordered", "词序颠倒"], ["split", "拆在标题和正文"], ["paraphrase", "同义改写"]];
    var t = el("table");
    var tr = el("tr", null, [el("th", { text: "引擎" })]); cols.forEach(function (c) { tr.appendChild(el("th", { text: c[1] })); }); t.appendChild(el("thead", null, [tr]));
    var tb = el("tbody");
    ENGINES.forEach(function (e) {
      var v = s.variants[e.id];
      var x = el("tr", null, [el("td", { class: "k", text: e.name })]);
      cols.forEach(function (c) {
        var p = v[c[0]];
        var td = el("td", { class: "heat", text: fmtPct(p) });
        var step = p <= 0 ? null : p < 0.34 ? "--ramp-2" : p < 0.67 ? "--ramp-3" : p < 0.95 ? "--ramp-4" : "--ramp-5";
        if (step) { td.style.background = "var(" + step + ")"; if (step === "--ramp-4" || step === "--ramp-5") td.style.color = "#fff"; }
        x.appendChild(td);
      });
      tb.appendChild(x);
    });
    t.appendChild(tb);
    host.appendChild(el("div", { class: "tscroll" }, [t]));
  }

  function renderScoped() {
    try { localStorage.setItem("bench-filters", JSON.stringify(state)); } catch (e) {}
    pareto(); metrics(); categories(); variants();
  }
  renderScoped();
})();
`;

export function renderHtml(r: BenchReport): string {
  const embedded = { ...r, sizes: r.sizes.map(({ perQuery: _drop, ...rest }) => rest) };
  const json = JSON.stringify(embedded).replace(/</g, "\\u003c");
  const env = r.env;
  const big = r.sizes[r.sizes.length - 1]!;
  const sizesText = r.sizes.map((s) => (s.n >= 1000 ? `${s.n / 1000}k` : String(s.n))).join(" / ");
  return `<title>Items Search Bench</title>
<style>${CSS}</style>
<div class="wrap">
<header>
  <h1>工单搜索：FTS5 + BM25 对比 grep</h1>
  <p class="lede">同一份带标注的合成 backlog（${r.queryCount} 条查询，12 个类别，中英文各半）跑在 ${sizesText} 条工单上。四个引擎：<b>grep</b> 是 main 上的旧路径，取全部行后整句小写子串匹配；<b>instr</b> 用和 FTS 相同的按词 AND 语义但不建索引；<b>FTS5 + BM25</b> 是当前分支的默认，标题按 5:1 加权；<b>FTS5 短语</b>是把整句加引号交给同一个索引，也就是 grep 的语义加上索引和排序。svc 两条走真实 Items 服务端到端，含 hydrate。</p>
  <div class="env"><span><b>日期</b> ${env.date}</span><span><b>CPU</b> ${env.cpu}</span><span><b>Node</b> ${env.node}</span><span><b>SQLite</b> ${env.sqlite}</span><span><b>seed</b> ${env.seed}</span><span><b>平均标题+正文</b> ${big.avgBytes.toFixed(0)} B</span></div>
</header>

<div class="kpis" id="kpis"></div>

<section>
  <h2>延迟随规模的变化</h2>
  <p class="sub">每条查询取 3 次运行的中位数；点是所有查询的 p50，向右的细线延伸到 p95，横轴是对数。旧的 list_items 先 hydrate 全部行再过滤，超过约 1.6 万条就会撞上 SQLite 的 32766 个绑定参数上限。</p>
  <div class="card">
    <div class="legend"><span class="grep"><i class="dot" style="background:currentColor"></i>grep 家族</span><span class="instr"><i class="dot" style="background:currentColor"></i>instr</span><span class="phrase"><i class="dot" style="background:currentColor"></i>FTS5 短语</span><span class="fts"><i class="dot" style="background:currentColor"></i>FTS5 家族</span><span><i class="dot" style="background:var(--ink-2)"></i>原生 SQL</span><span class="ring" style="color:var(--ink-2)"><i class="ring"></i>服务端到端</span><span><i style="background:var(--ink-2)"></i>带 limit</span></div>
    <div id="latency"></div>
  </div>
</section>

<section>
  <h2>索引的代价</h2>
  <p class="sub">两边都不调用付费 API。代价是磁盘、写入时的 CPU，以及下面第三节里 agent 读回的 token。</p>
  <div class="card">
    <h3>库文件体积</h3>
    <p class="note">trigram 索引把每个字符位置都存了一遍，所以 items_fts 比正文本身大几倍。</p>
    <div class="legend"><span class="off"><i style="background:currentColor"></i>关索引</span><span class="on"><i style="background:currentColor"></i>开索引</span></div>
    <div id="storage"></div>
  </div>
  <div class="card">
    <h3>写入开销</h3>
    <p class="note">批量插入、更新、删除在一个事务里按行摊平；items.create 走完整的服务路径（写协议 + oplog），是用户实际感受到的每次开销。重建索引是 v14 迁移的一次性成本。</p>
    <div id="writes"></div>
  </div>
</section>

<section>
  <h2>准确性与 token</h2>
  <p class="sub">相关项 = 每个主题的四种表述（词相邻在标题、词序颠倒、拆在标题和正文、同义改写）。"主题查询"汇总 ${r.topicCategories.length} 个类别，不含拼写错误和同义词（词法搜索的天花板）以及工单号和短词（按字面标注）。选择规模和 limit，下面所有图表一起切换。</p>
  <div class="filters">
    <div class="group"><span>规模</span><div class="seg" id="seg-size" role="group" aria-label="规模"></div></div>
    <div class="group"><span>limit</span><div class="seg" id="seg-limit" role="group" aria-label="limit"></div></div>
  </div>
  <div class="card">
    <h3>召回率对读回的 token</h3>
    <p class="note">每个引擎三个点，从不限 limit 到最小的 limit，实心的是当前选中的那个；悬停看另外两个。好的引擎在左上：读得少，找得全。grep 的点重叠是因为它本来就返回很少的行；FTS5 短语和 grep 的结果集相同，点会完全重合，所以不画。</p>
    <div class="legend"><span class="grep"><i class="line" style="background:currentColor"></i>grep（main）</span><span class="instr"><i class="line" style="background:currentColor"></i>instr（无索引）</span><span class="fts"><i class="line" style="background:currentColor"></i>FTS5 + BM25</span></div>
    <div id="pareto"></div>
  </div>
  <div class="card">
    <h3>召回、精确率、MRR、前 5 条命中</h3>
    <p class="note">主题查询的平均值。instr 和 FTS 的结果集完全相同，两者之差就是 BM25 排序单独带来的；FTS5 短语和 grep 的结果集相同，两者之差同理。</p>
    <div class="legend"><span class="grep"><i style="background:currentColor"></i>grep（main）</span><span class="instr"><i style="background:currentColor"></i>instr（无索引）</span><span class="phrase"><i style="background:currentColor"></i>FTS5 短语</span><span class="fts"><i style="background:currentColor"></i>FTS5 + BM25</span></div>
    <div id="metrics"></div>
  </div>
  <div class="card">
    <h3>各类查询的召回率</h3>
    <p class="note">en/zh-phrase 是词按原顺序相邻，reordered 是词序颠倒，zh-words 是两个中文词中间有空格，single-2 是两字词（走 instr 回退，按标题是否命中排序），key 是工单号，short 是 UI、db 这类短词。</p>
    <div class="legend"><span class="grep"><i style="background:currentColor"></i>grep（main）</span><span class="fts"><i style="background:currentColor"></i>FTS5 + BM25</span></div>
    <div id="categories"></div>
  </div>
  <div class="card">
    <h3>每种表述形式被找到的比例</h3>
    <p class="note">只看词分开的查询（en-phrase、en-reordered、zh-words），不限 limit。同义改写一列是词法搜索到不了的部分。</p>
    <div id="variants"></div>
  </div>
</section>

<section>
  <h2>怎么读这些数字</h2>
  <ul class="notes">
    <li>数据是合成的：40 个主题各 4 种表述，其余是共用词表的干扰工单，所以两个词恰好同时出现在无关工单里的概率比真实项目高，FTS 在大库上的精确率是偏保守的估计。</li>
    <li>token 按 <code>list_items</code> 实际返回的 JSON 估算：中日韩字符每字 1 个，其余每 4 字节 1 个。</li>
    <li>grep 加 limit 只是把结果截断，它仍然要读完全部行；FTS 和 instr 的 limit 下推到了 SQL。</li>
    <li>两字词（多数中文词）走 <code>instr()</code> 回退，看不到 BM25，只按"标题里是否命中"排，所以 zh-single-2 的排序增益有限。</li>
    <li>引号语法：<code>"login timeout"</code> 或 <code>“登录 超时”</code> 作为一个连续短语匹配，就是图里的 FTS5 短语引擎。</li>
    <li>命令：<code>pnpm bench:search</code>，环境变量 <code>TOMRADE_BENCH_SIZES</code>、<code>TOMRADE_BENCH_LIMITS</code>、<code>TOMRADE_BENCH_SEED</code>。</li>
  </ul>
</section>
</div>
<div id="tip" role="tooltip" hidden></div>
<script>window.__BENCH__ = ${json};</script>
<script>${SCRIPT}</script>
`;
}
