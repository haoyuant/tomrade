/**
 * Cuts a short from a window take of film.mjs, one exact frame at a time: laid out at 1920×1080 (or 1080×1920), rendered at 4K, 60 fps, everything on the beat of
 * film-audio.mjs. An edit is all data, so a change is a line in edit.json and a render. There are no caption cards: big type sits on the paper, beside
 * or above the window, and the camera moves the window out of its way.
 *
 * From apps/desktop: npx electron scripts/film-short.mjs <edit.json> <take.mp4> <out.mp4>
 * FILM_STILLS=1.2,4.5 writes those moments next to <out> as PNGs and stops, for checking a layout without a render.
 *
 * edit.json:
 *   { "seconds", "music", "sections": [[from, name], …], "stage"?: "tall",
 *     "stages"?: [[from, "paper" | "night"], …],
 *     "src": { "top", "width" },           window chrome cut from the top, and the window's width in points
 *     "map": [[out, take, source?], …],    output time → take time, straight between points; source indexes the takes, given comma-separated
 *     "smooth"?: [[from, to], …],          output stretches played near 1× whose motion is interpolated up to 60 fps (a window capture runs ~22)
 *     "shots": { name: { x, y, w, veil?, veilTop?, top?, spot?: [x, y, w, h] } },  spot: only that stage rectangle shows  where the whole window sits on the 1920×1080 stage; veil and veilTop fade its right or top end into the stage, top cuts that much window chrome
 *     "cam": [[out, shot, seconds?], …],   arrive at that shot by that time, moving for that long
 *     "title": { "to", "blocks": [{ "at", "en", "zh" }], "dusk"?, "agents": { "at": [], "steps": [], "lines": [], "asleep"? } },
 *              or, in place of agents, "terminal": { "at", "command", "typeFrom", "typeTo", "lines": [{ "at", "text", "tone"? }] }
 *              a terminal window whose command types itself out and whose lines pop in; tone: ok | branch | pr
 *              or "pile": { "at": [], "lines": [], "cards": [{ "key", "title" }] }   tickets fall on you one by one, each tagged with its line
 *              or "mailbox": { "at": [], "lines": [] }   bots queue behind a mailbox, and a letter carrying each line floats into it
 *              or "branches": { "at": [], "names": [], "lines": [], "zh": [] }   branches sprout off your trunk, each tag sulking at you
 *              or "tiles": { "at": [], "items": [{ "icon", "name" }] }   plugin tiles fly in and snap into a 3×2 grid, one per beat
 *              or "chat": { "lines": [{ "at", "who": "you" | "bot", "text", "button"? }] }   a phone whose chat fills in, one bubble per beat
 *              or "idea": { "said", "at", "cards": [{ "at", "key", "title" }], "links": [{ "at", "from", "to" }] }   one sentence splits into linked tickets
 *              or "folder": { "at": [], "items": [{ "kind": "note" | "doc" | "diagram", "name" }] }   each item flies into a folder that glows as it lands
 *     "cards"?: [{ "from", "to", …as title }],   full-stage cards later on; their times inside are from "from"
 *     "texts": [{ "from", "to", "x", "y", "w", "align"?, "size"?, "en", "gray"?, "zh"?, "inline"?, "hotTo"? }],  hotTo: red until then, for the newest of a run
 *     "end": { "from", "en", "zh", "url" },
 *     "fast": [{ "from", "to", "label" }], "sfx": [{ "t", "kind", "note"? }],
 *     "cardgrid"?: { "source", "bar"?, "cells": [{ x, y, w, h, title, zh? }] },  a take composed as a grid: drawn as named cards
 *     "cells": { no: { x, y, w, h } }, "flashes": [{ "t", "cell", "to"? }] }  panes in window points, lit as answers reach them; with "to", held lit until then
 */
import { app, BrowserWindow } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mix } from "./film-audio.mjs";

const [editFile, takes, out] = process.argv.slice(2);
const sources = takes.split(",");
const take = sources[0];
const dir = path.dirname(fileURLToPath(import.meta.url));
// "stage": "tall" lays a short out at 1080×1920 for phone feeds; the title animations, drawn for the wide stage, are
// moved into its lower half.
const TALL = JSON.parse(fs.readFileSync(editFile, "utf8")).stage === "tall";
const W = TALL ? 1080 : 1920;
const H = TALL ? 1920 : 1080;
const ART = TALL ? "translate(-1026 780) scale(1.08)" : "";
const FPS = 60;
// Laid out at 1920×1080 and rendered at this multiple: 4K by default, so small text in a wide shot stays readable.
const OUT = Number(process.env.FILM_OUT_SCALE ?? 2);
app.disableHardwareAcceleration();

const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const lerp = (a, b, p) => a + (b - a) * p;
const clamp = (p) => Math.max(0, Math.min(1, p));
const out3 = (p) => 1 - (1 - clamp(p)) ** 3;
const pop = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2);
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
};
const probe = (file) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" }).stdout).streams[0];

const INK = "#1d1d1f";
const SANS = `-apple-system,"SF Pro Display","PingFang SC",sans-serif`;
const PAGE = (video, icon) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#f6efe3;font-family:${SANS};color:${INK};-webkit-font-smoothing:antialiased}
  .bg{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 118%,#f7cfa8 0%,#f6e3cd 38%,#f6efe3 70%)}
  canvas{position:absolute;left:0;top:0}
  video{position:absolute;left:-99999px;width:10px}
  .t{position:absolute;box-sizing:border-box}
  .t .en{font-weight:700;line-height:1.06;letter-spacing:-.022em;white-space:pre-line}
  .t .gray{color:#86868b}
  .t .zh{font-weight:500;color:#6e6e73;margin-top:.5em}
  .t.inline{display:flex;align-items:baseline;gap:18px}
  .t.inline .zh{margin:0}
  .t.hot .en{color:#c4492c}
  body.night{background:#15142a}
  .night .bg{background:radial-gradient(120% 90% at 50% 118%,#7a5270 0%,#3a2f5c 34%,#1b1a35 66%,#15142a 100%)}
  .night .t .en{color:#f5f5f7}
  .night .t .zh{color:#b6b6c0}
  .night .t.hot .en{color:#ff8a5c}
  .night #fast{color:#b6b6c0}
  #title.dusk .bgf{background:radial-gradient(90% 70% at 50% 112%,#a56a6a 0%,#5b4270 34%,#2a2748 62%,#15142a 92%)}
  #title.dusk .t .en{color:#f5f5f7}
  #title.dusk .t .zh{color:#b6b6c0}
  #title:not(.dusk) .t .en{color:${INK}}
  #title:not(.dusk) .t .zh{color:#6e6e73}
  #fast{position:absolute;right:48px;top:34px;font:600 24px "SF Mono",Menlo,monospace;color:#6e6e73;transform-origin:right center}
  .full{position:absolute;inset:0;opacity:0}
  .full .bgf{position:absolute;inset:0;background:radial-gradient(90% 70% at 50% 112%,#f4a66f 0%,#f7cfa8 34%,#f6e3cd 62%,#f6efe3 88%)}
  #title svg{position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 10px 18px rgba(70,40,20,.14))}
  #term{position:absolute;left:1010px;top:330px;width:800px;box-sizing:border-box;border-radius:22px;background:#1c1b2b;box-shadow:0 30px 70px rgba(70,40,20,.32);overflow:hidden;transform-origin:50% 60%}
  #term .bar{height:44px;display:flex;align-items:center;gap:10px;padding:0 20px;background:#2a2939}
  #term .bar i{width:14px;height:14px;border-radius:50%;display:block}
  #term .body{padding:26px 32px 34px;font:500 30px/1.6 "SF Mono",Menlo,monospace;color:#e8e6f0;white-space:pre}
  #term .cmd .p{color:#f4a66f}
  #term .caret{display:inline-block;width:.6em;height:1.05em;vertical-align:-.18em;background:#e8e6f0;margin-left:2px}
  #term .ln{display:block}
  #term .ok{color:#8bd49c}
  #term .branch{color:#c9b6ff}
  #term .pr{color:#f4a66f}
  #end>div:not(.bgf),#end>img{position:relative}
  ${TALL ? `#term{left:140px;top:1080px}
  #end .en{font-size:80px !important;padding:0 60px}
  #end .zh{font-size:40px !important;padding:0 60px}` : ""}
  #end{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  #end .en{font-weight:700;font-size:104px;line-height:1.06;letter-spacing:-.022em;white-space:pre-line}
  #end .zh{font-weight:500;font-size:46px;color:#6e6e73;margin-top:26px}
  #end img{width:132px;height:132px;border-radius:30px;margin-bottom:38px;box-shadow:0 18px 50px rgba(70,40,20,.25)}
  #end .url{font:600 30px "SF Mono",Menlo,monospace;color:#c4492c;margin-top:36px}
</style><body><div class="bg"></div><canvas width="${W * OUT}" height="${H * OUT}" style="width:${W}px;height:${H}px"></canvas><video src="${video}" muted preload="auto"></video>
<div id="texts"></div><div id="fast"></div>
<div class="full" id="title"><div class="bgf"></div><svg viewBox="0 0 ${W} ${H}"></svg><div id="term"></div><div id="blocks"></div></div>
<div class="full" id="end"><div class="bgf"></div><img src="${icon}"><div class="en"></div><div class="zh"></div><div class="url"></div></div>
<script>
  const video = document.querySelector('video');
  const ctx = document.querySelector('canvas').getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const esc = (t) => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const textHtml = (c) => '<div class="t' + (c.inline ? ' inline' : '') + (c.hot ? ' hot' : '') + '" style="left:' + c.x + 'px;top:' + c.y + 'px;width:' + c.w + 'px;text-align:' + (c.align || 'left') + ';opacity:' + c.opacity + ';transform:translateY(' + c.dy + 'px)">'
    + '<div class="en" style="font-size:' + (c.size || 88) + 'px">' + esc(c.en) + (c.gray ? '<span class="gray"> ' + esc(c.gray) + '</span>' : '') + '</div>'
    + (c.zh ? '<div class="zh" style="font-size:' + (c.zhSize || 38) + 'px">' + esc(c.zh) + '</div>' : '') + '</div>';
  const set = (root, q, text) => { const n = root.querySelector(q); if (n && n.textContent !== text) n.textContent = text; };
  // The little crowd of the opening: bots, not people, so the joke is only about being outnumbered.
  const INK = '${INK}';
  const dusk = () => document.getElementById('title').classList.contains('dusk');
  const rim = () => (dusk() ? ' stroke="rgba(255,255,255,.28)" stroke-width="2"' : '');
  const botSvg = (b) => {
    const eye = (x) => '<circle cx="' + x + '" cy="-8" r="16" fill="#fff"/><circle cx="' + (x + b.lookX * 7) + '" cy="' + (-8 + b.lookY * 7) + '" r="7" fill="' + INK + '"/>';
    return '<g transform="translate(' + b.x + ' ' + b.y + ') scale(' + b.k + ')">'
      + '<line x1="0" y1="-52" x2="0" y2="-84" stroke="' + INK + '" stroke-width="7" stroke-linecap="round"/><circle cy="-90" r="10" fill="' + INK + '"/>'
      + '<rect x="-60" y="-58" width="120" height="104" rx="32" fill="' + INK + '"' + rim() + '/>'
      + '<rect x="-36" y="40" width="22" height="20" rx="8" fill="' + INK + '"/><rect x="14" y="40" width="22" height="20" rx="8" fill="' + INK + '"/>'
      + eye(-25) + eye(25) + '</g>';
  };
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '600 27px ${SANS.replace(/"/g, "")}';
  // Measured, not guessed; a bubble on a side seat grows away from its bot, so a long line never reaches the next one.
  const bubbleSvg = (b) => {
    const w = measure.measureText(b.line).width + 48;
    // On the tall stage the art is moved and scaled (ART), and a side bubble could leave the frame: keep it 24 px inside.
    const half = (w / 2) * b.q;
    const cx = ${TALL} ? Math.min(Math.max(b.bx + b.side * Math.max(0, w / 2 - 56), (1026 + 24) / 1.08 + half), (1026 + 1080 - 24) / 1.08 - half) : b.bx + b.side * Math.max(0, w / 2 - 56);
    return '<g transform="translate(' + cx + ' ' + b.by + ') scale(' + b.q + ')"><rect x="' + -w / 2 + '" y="-28" width="' + w + '" height="56" rx="28" fill="#fff"/>'
      + '<text text-anchor="middle" y="10" font-size="27" font-weight="600" letter-spacing="-.2" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(b.line) + '</text></g>';
  };
  const MONO = '"SF Mono",Menlo,monospace';
  const ticketSvg = (c) => {
    const tone = /dup/i.test(c.line) ? ['#c4492c', 'rgba(196,73,44,.13)'] : /big/i.test(c.line) ? ['#a45f00', 'rgba(222,140,20,.16)'] : ['#5b4fc4', 'rgba(91,79,196,.13)'];
    const tw = c.line.length * 14 + 26;
    return '<g transform="translate(' + c.x + ' ' + c.y + ') rotate(' + c.rot + ')">'
      + '<rect x="-150" y="-56" width="300" height="112" rx="14" fill="#fff" stroke="#e7ded3" stroke-width="2"/>'
      + '<text x="-128" y="-20" font-size="20" font-weight="600" fill="#86868b" font-family=\\'' + MONO + '\\'>' + esc(c.key) + '</text>'
      + '<text x="-128" y="10" font-size="23" font-weight="600" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(c.title) + '</text>'
      + '<rect x="-128" y="20" width="' + tw + '" height="26" rx="7" fill="' + tone[1] + '"/>'
      + '<text x="' + (-128 + tw / 2) + '" y="39" text-anchor="middle" font-size="17" font-weight="700" fill="' + tone[0] + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(c.line) + '</text></g>';
  };
  const mailboxSvg = (m) => {
    const x = m.x, y = m.y;
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + (1 + m.bump * 0.05) + ' ' + (1 - m.bump * 0.04) + ')">'
      + '<rect x="-15" y="80" width="30" height="190" rx="6" fill="' + INK + '"' + rim() + '/>'
      + '<path d="M-135 90 V-10 A135 110 0 0 1 135 -10 V90 Z" fill="#c4492c"' + rim() + '/>'
      + '<rect x="-78" y="-40" width="156" height="20" rx="10" fill="' + INK + '"/>'
      + '<g transform="translate(138 40) rotate(' + m.flag + ')"><rect x="-5" y="-92" width="10" height="96" rx="4" fill="' + INK + '"/><rect x="5" y="-92" width="54" height="34" rx="5" fill="#ffcc33"/></g>'
      + '</g>';
  };
  const letterSvg = (l) => '<g transform="translate(' + l.x + ' ' + l.y + ') rotate(' + l.rot + ') scale(1.2 ' + 1.2 * l.sy + ')">'
    + '<rect x="-80" y="-50" width="160" height="100" rx="10" fill="#fff" stroke="#e7ded3" stroke-width="2"/>'
    + '<path d="M-78 -46 L0 8 L78 -46" fill="none" stroke="#e0d4c6" stroke-width="3"/>'
    + '<text text-anchor="middle" y="38" font-size="26" font-weight="700" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(l.line) + '</text></g>';
  const branchSvg = (b) => {
    const len = 900;
    return '<path d="' + b.path + '" fill="none" stroke="' + b.color + '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + len + '" stroke-dashoffset="' + len * (1 - b.grow) + '"/>'
      + '<circle cx="' + b.sx + '" cy="' + b.sy + '" r="10" fill="' + b.color + '"/>'
      + (b.grow > 0.5 ? '<circle cx="' + b.mx + '" cy="' + b.my + '" r="9" fill="#fff" stroke="' + b.color + '" stroke-width="5"/>' : '');
  };
  const tagSvg = (b) => {
    const w = Math.max(measure.measureText(b.line).width * 30 / 27, b.zh.length * 22) + 44;
    return '<g transform="translate(' + b.tx + ' ' + b.ty + ') rotate(' + b.rot + ' 0 46) scale(' + b.q + ')">'
      + '<rect x="' + -w / 2 + '" y="-62" width="' + w + '" height="112" rx="16" fill="#fff" stroke="' + b.color + '" stroke-width="3"/>'
      + '<text x="' + (-w / 2 + 20) + '" y="-30" font-size="18" font-weight="600" fill="' + b.color + '" font-family=\\'' + MONO + '\\'>⎇ ' + esc(b.name) + '</text>'
      + '<text x="' + (-w / 2 + 20) + '" y="4" font-size="30" font-weight="700" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(b.line) + '</text>'
      + '<text x="' + (-w / 2 + 20) + '" y="34" font-size="21" font-weight="500" fill="#6e6e73" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(b.zh) + '</text></g>';
  };
  const fileSvg = (f) => {
    const body = f.kind === 'diagram'
      ? '<rect x="-62" y="-38" width="40" height="26" rx="5" fill="#cfe6ff" stroke="#3a7bd5" stroke-width="3"/><rect x="18" y="-38" width="40" height="26" rx="5" fill="#d9f3e4" stroke="#2f9e6e" stroke-width="3"/><rect x="-22" y="8" width="44" height="26" rx="5" fill="#fde3d3" stroke="#c4492c" stroke-width="3"/><path d="M-22 -25 H18 M-42 -12 V21 H-22 M38 -12 V21 H22" fill="none" stroke="' + INK + '" stroke-width="3"/>'
      : f.kind === 'doc'
        ? '<rect x="-56" y="-42" width="112" height="14" rx="4" fill="#c4492c"/>' + [0, 1, 2, 3].map((i) => '<rect x="-56" y="' + (-18 + i * 16) + '" width="' + (112 - (i % 2) * 34) + '" height="7" rx="3.5" fill="#d8cfc6"/>').join('')
        : '<text x="-56" y="-22" font-size="22" font-weight="700" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>#</text>' + [0, 1, 2].map((i) => '<rect x="' + (i ? -56 : -34) + '" y="' + (-34 + i * 22 + (i ? 10 : 0)) + '" width="' + (i ? 104 : 80) + '" height="8" rx="4" fill="#d8cfc6"/>').join('') + '<rect x="-56" y="30" width="56" height="9" rx="4.5" fill="#cfe6ff"/>';
    return '<g transform="translate(' + f.x + ' ' + f.y + ') rotate(' + f.rot + ') scale(' + f.k + ')">'
      + '<rect x="-80" y="-62" width="160" height="124" rx="14" fill="#fff" stroke="#e7ded3" stroke-width="2"/>' + body
      + '<text x="0" y="98" text-anchor="middle" font-size="22" font-weight="600" fill="#6e6e73" font-family=\\'' + MONO + '\\'>' + esc(f.name) + '</text></g>';
  };
  const folderSvg = (d) => '<g transform="translate(' + d.x + ' ' + d.y + ') scale(' + (1 + d.bump * 0.06) + ' ' + (1 - d.bump * 0.05) + ')">'
    + '<circle r="230" fill="rgba(244,166,111,' + (0.22 * d.glow) + ')"/>'
    + '<path d="M-170 -90 H-60 L-30 -60 H170 V110 H-170 Z" fill="#e8955f"/>'
    + '<path d="M-182 -38 H182 L166 120 H-166 Z" fill="#f4a66f"/>'
    + '<text y="70" text-anchor="middle" font-size="34" font-weight="700" fill="#fff" font-family=\\'${SANS.replace(/"/g, "")}\\'>Files</text></g>';
  const tileSvg = (p) => '<g transform="translate(' + p.x + ' ' + p.y + ') rotate(' + p.rot + ') scale(' + p.k + ')">'
    + '<rect x="-112" y="-82" width="224" height="164" rx="26" fill="#fff" stroke="' + (p.lit > 0 ? 'rgba(196,73,44,' + p.lit + ')' : '#e7ded3') + '" stroke-width="' + (2 + 3 * p.lit) + '"/>'
    + '<text y="12" text-anchor="middle" font-size="64">' + esc(p.icon) + '</text>'
    + '<text y="62" text-anchor="middle" font-size="24" font-weight="600" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(p.name) + '</text></g>';
  const chatSvg = (c) => {
    let y = 300, out = '<rect x="1160" y="150" width="480" height="800" rx="64" fill="#1c1b2b"/><rect x="1180" y="170" width="440" height="760" rx="48" fill="#2b2d3a"/>'
      + '<rect x="1340" y="186" width="120" height="28" rx="14" fill="#1c1b2b"/>'
      + '<text x="1400" y="262" text-anchor="middle" font-size="24" font-weight="700" fill="#f5f5f7" font-family=\\'${SANS.replace(/"/g, "")}\\'>Tomrade</text>';
    for (const l of c.lines) {
      const w = Math.min(360, measure.measureText(l.text).width * 24 / 27 + 40), h = l.button ? 104 : 56;
      const x = l.who === 'you' ? 1600 - w : 1200;
      out += '<g transform="translate(' + (x + w / 2) + ' ' + (y + h / 2) + ') scale(' + l.q + ') translate(' + (-w / 2) + ' ' + (-h / 2) + ')">'
        + '<rect width="' + w + '" height="' + h + '" rx="20" fill="' + (l.who === 'you' ? '#c4492c' : '#3b3e4f') + '"/>'
        + '<text x="20" y="36" font-size="24" font-weight="600" fill="#fff" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(l.text) + '</text>'
        + (l.button ? '<rect x="20" y="56" width="96" height="34" rx="8" fill="#5865f2"/><text x="68" y="80" text-anchor="middle" font-size="20" font-weight="700" fill="#fff" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(l.button) + '</text>' : '')
        + '</g>';
      y += h + 18;
    }
    return out;
  };
  const ideaSvg = (d) => {
    let out = '';
    if (d.bubble > 0) {
      const w = 780;
      out += '<g transform="translate(1440 360) scale(' + d.bubble + ')" opacity="' + d.fade + '"><rect x="' + -w / 2 + '" y="-62" width="' + w + '" height="124" rx="40" fill="#fff" stroke="#e7ded3" stroke-width="2"/>'
        + '<path d="M-220 68 l-28 50 l70 -50 z" fill="#fff"/>'
        + '<text text-anchor="middle" y="12" font-size="34" font-weight="600" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(d.said) + '</text></g>';
    }
    for (const l of d.links) out += '<path d="M' + l.x1 + ' ' + l.y + ' L' + (l.x1 + (l.x2 - l.x1) * l.p) + ' ' + l.y + '" stroke="#c4492c" stroke-width="5" stroke-linecap="round"/>'
      + (l.p >= 1 ? '<path d="M' + (l.x2 - 16) + ' ' + (l.y - 10) + ' L' + l.x2 + ' ' + l.y + ' L' + (l.x2 - 16) + ' ' + (l.y + 10) + '" fill="none" stroke="#c4492c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' : '');
    for (const c of d.cards) out += '<g transform="translate(' + c.x + ' ' + c.y + ') scale(' + c.k + ')"><rect x="-130" y="-64" width="260" height="128" rx="16" fill="#fff" stroke="#e7ded3" stroke-width="2"/>'
      + '<text x="-118" y="-32" font-size="22" font-weight="600" fill="#86868b" font-family=\\'' + MONO + '\\'>' + esc(c.key) + '</text>'
      + c.title.split('\\n').map((t, i) => '<text x="-118" y="' + (6 + i * 32) + '" font-size="27" font-weight="600" fill="' + INK + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>' + esc(t) + '</text>').join('') + '</g>';
    return out;
  };
  const youSvg = (y) => '<g transform="translate(' + y.x + ' ' + y.y + ') scale(' + y.k * (1 + 0.5 * (1 - (y.sq ?? 1))) + ' ' + y.k * (y.sq ?? 1) + ')"><circle r="68" fill="#fff"/>'
    + (y.asleep
      ? '<path d="M-32 -8 q10 9 20 0 M12 -8 q10 9 20 0" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/><ellipse cy="26" rx="6" ry="4.5" fill="' + INK + '"/>'
        + y.zs.map((z) => '<text x="' + z.x + '" y="' + z.y + '" font-size="' + z.size + '" font-weight="700" fill="#fff" opacity="' + z.o + '">z</text>').join('')
      : '<circle cx="-22" cy="-8" r="7" fill="' + INK + '"/><circle cx="22" cy="-8" r="7" fill="' + INK + '"/><path d="M-14 26 q7 -9 14 0 t14 0" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>'
        + '<path d="M50 -56 q16 22 0 30 q-16 -8 0 -30" fill="#8cc6f2" opacity="' + y.sweat + '"/>')
    + '<text text-anchor="middle" y="112" font-size="30" font-weight="600" fill="' + (dusk() ? '#f5f5f7' : INK) + '" font-family=\\'${SANS.replace(/"/g, "")}\\'>You</text></g>';
  window.frame = async (s) => {
    document.body.classList.toggle('night', s.stage === 'night');
    if (Math.abs(video.currentTime - s.time) > 1e-4 || video.readyState < 2) {
      await new Promise((r) => { const done = () => { clearTimeout(guard); r(); }; const guard = setTimeout(done, 800); video.addEventListener('seeked', done, { once: true }); video.currentTime = s.time; });
    }
    ctx.setTransform(${OUT}, 0, 0, ${OUT}, 0, 0);
    ctx.clearRect(0, 0, ${W}, ${H});
    const d = s.win, r = 16 * Math.max(1, d.w / 1800);
    ctx.save();
    ctx.shadowColor = 'rgba(70,40,20,.3)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 22;
    ctx.beginPath();
    ctx.roundRect(d.x, d.y, d.w, d.h, r);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(d.x, d.y, d.w, d.h, r);
    ctx.clip();
    // Only the part on stage, at the take's own pixels.
    const k = d.w / s.src.w;
    const sx = Math.max(0, -d.x / k), sy = Math.max(0, -d.y / k);
    const sw = Math.min(s.src.w - sx, (${W} - Math.max(0, d.x)) / k), sh = Math.min(s.src.h - sy, (${H} - Math.max(0, d.y)) / k);
    ctx.drawImage(video, s.src.x + sx, s.src.y + sy, sw, sh, Math.max(0, d.x), Math.max(0, d.y), sw * k, sh * k);
    // A grid of cards: the stage between them, rounded corners, and each card's name on its white bar.
    if (s.cards) {
      const paper = s.stage === 'night' ? '#15142a' : '#f6efe3';
      ctx.beginPath();
      ctx.rect(d.x, d.y, d.w, d.h);
      for (const c of s.cards) ctx.roundRect(c.x, c.y, c.w, c.h, c.bar * 0.32);
      ctx.fillStyle = paper;
      ctx.fill('evenodd');
      for (const c of s.cards) {
        ctx.strokeStyle = 'rgba(70,40,20,.10)';
        ctx.lineWidth = Math.max(1, c.bar * 0.02);
        ctx.beginPath(); ctx.roundRect(c.x, c.y, c.w, c.h, c.bar * 0.32); ctx.stroke();
        ctx.strokeStyle = 'rgba(70,40,20,.08)';
        ctx.beginPath(); ctx.moveTo(c.x, c.y + c.bar); ctx.lineTo(c.x + c.w, c.y + c.bar); ctx.stroke();
        const size = c.bar * 0.42;
        ctx.textBaseline = 'middle';
        ctx.font = '700 ' + size + 'px ${SANS.replace(/"/g, "")}';
        ctx.fillStyle = INK;
        ctx.fillText(c.title, c.x + c.bar * 0.36, c.y + c.bar / 2);
        if (c.zh) {
          const w = ctx.measureText(c.title).width;
          ctx.font = '500 ' + size * 0.86 + 'px ${SANS.replace(/"/g, "")}';
          ctx.fillStyle = '#86868b';
          ctx.fillText(c.zh, c.x + c.bar * 0.36 + w + size * 0.5, c.y + c.bar / 2);
        }
      }
    }
    // The pane a card's answer went to lights up: the sidebar reaching across the window.
    for (const f of s.flashes) {
      ctx.fillStyle = 'rgba(196,73,44,' + 0.14 * f.alpha + ')';
      ctx.strokeStyle = 'rgba(196,73,44,' + f.alpha + ')';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.roundRect(f.x, f.y, f.w, f.h, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    // A spotlight: everything but one rectangle of the window goes back under the stage.
    if (s.spot && s.spot.a > 0) {
      const [sx, sy, sw, sh] = s.spot.r, color = s.stage === 'night' ? '21,20,42' : '246,239,227';
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ${W}, ${H});
      ctx.roundRect(sx, sy, sw, sh, 22);
      ctx.fillStyle = 'rgba(' + color + ',' + s.spot.a + ')';
      ctx.fill('evenodd');
      ctx.restore();
    }
    // A window wider than its place fades into the stage, so the type beside it reads on the stage alone.
    if (s.veil > 0) {
      const edge = ctx.createLinearGradient(${W - 670}, 0, ${W - 480}, 0);
      const color = s.stage === 'night' ? '21,20,42' : '246,239,227';
      edge.addColorStop(0, 'rgba(' + color + ',0)');
      edge.addColorStop(1, 'rgba(' + color + ',' + s.veil + ')');
      ctx.fillStyle = edge;
      ctx.fillRect(${W - 670}, 0, 670, ${H});
    }
    if (s.veilTop > 0) {
      // the band the type stands in: above the window, deeper on a tall stage
      const band = ${TALL ? 500 : 200};
      const edge = ctx.createLinearGradient(0, band, 0, band + 100);
      const color = s.stage === 'night' ? '21,20,42' : '246,239,227';
      edge.addColorStop(0, 'rgba(' + color + ',' + s.veilTop + ')');
      edge.addColorStop(1, 'rgba(' + color + ',0)');
      ctx.fillStyle = edge;
      ctx.fillRect(0, band, ${W}, 100);
      ctx.fillStyle = 'rgba(' + color + ',' + s.veilTop + ')';
      ctx.fillRect(0, 0, ${W}, band);
    }
    document.getElementById('texts').innerHTML = s.texts.map(textHtml).join('');
    const fast = document.getElementById('fast');
    fast.textContent = s.fast.label;
    fast.style.opacity = s.fast.in;
    const title = document.getElementById('title');
    title.style.opacity = s.title ? 1 : 0;
    if (s.title) {
      title.classList.toggle('dusk', !!s.title.dusk);
      title.style.transform = 'translateY(' + s.title.y + 'px)';
      title.querySelector('svg').innerHTML = '<g transform="${ART}">' + s.title.bots.map(botSvg).join('') + (s.title.you ? youSvg(s.title.you) : '') + s.title.bots.filter((b) => b.q > 0).map(bubbleSvg).join('') + (s.title.pile || []).map(ticketSvg).join('')
        + (s.title.mailbox ? mailboxSvg(s.title.mailbox) + s.title.mailbox.letters.map(letterSvg).join('') : '')
        + (s.title.idea ? ideaSvg(s.title.idea) : '')
        + (s.title.chat ? chatSvg(s.title.chat) : '')
        + (s.title.tiles ? s.title.tiles.map(tileSvg).join('') : '')
        + (s.title.folder ? s.title.folder.back.map(fileSvg).join('') + folderSvg(s.title.folder) + s.title.folder.front.map(fileSvg).join('') : '')
        + (s.title.branches ? '<path d="M' + s.title.branches.trunk.join(' L') + '" stroke="' + INK + '" stroke-width="9" stroke-linecap="round" fill="none"/>'
          + s.title.branches.list.map(branchSvg).join('') + youSvg(s.title.branches.you) + s.title.branches.list.filter((b) => b.q > 0).map(tagSvg).join('') : '') + '</g>';
      const term = document.getElementById('term'), tm = s.title.terminal;
      term.style.display = tm ? 'block' : 'none';
      if (tm) {
        term.style.opacity = Math.min(1, tm.k * 1.4);
        term.style.transform = 'scale(' + (0.86 + 0.14 * tm.k) + ')';
        term.innerHTML = '<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><div class="body">'
          + '<span class="ln cmd"><span class="p">~/feedback-form ❯</span> ' + esc(tm.typed) + (tm.caret ? '<span class="caret"></span>' : '') + '</span>'
          + tm.lines.map((l) => '<span class="ln ' + (l.tone || '') + '" style="opacity:' + l.q + ';transform:translateY(' + 16 * (1 - l.q) + 'px)">' + esc(l.text) + '</span>').join('')
          + '</div>';
      }
      const blocks = document.getElementById('blocks');
      blocks.innerHTML = s.title.blocks.map(textHtml).join('');
      // A block's y is where it would like to sit; one that wrapped above it pushes it down rather than running into it.
      let below = 0;
      for (const n of blocks.children) {
        const top = Math.max(parseFloat(n.style.top), below);
        n.style.top = top + 'px';
        below = top + n.offsetHeight + 36;
      }
    }
    const end = document.getElementById('end');
    end.style.opacity = s.end ? s.end.opacity : 0;
    if (s.end) {
      set(end, '.en', s.end.en); set(end, '.zh', s.end.zh); set(end, '.url', s.end.url);
      for (const q of ['.en', '.zh']) { const n = end.querySelector(q); n.style.opacity = s.end.in; n.style.transform = 'translateY(' + 24 * (1 - s.end.in) + 'px)'; }
    }
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
  };
</script>`;


async function run() {
  const edit = JSON.parse(fs.readFileSync(editFile, "utf8"));
  const size = probe(take);
  const top = edit.src?.top ?? 0;
  const view = { w: edit.src?.width ?? size.width, h: (edit.src?.width ? size.height * edit.src.width / size.width : size.height) - top };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-short-"));

  // Edit times are in window points; a native-pixel take has `scale` pixels to each.
  const scale = size.width / (edit.src?.width ?? size.width);
  // A proxy of exactly the frames the film shows, already retimed, so each output frame is one exact seek into it.
  const moves = edit.map.slice(1).map((m, i) => ({ o0: edit.map[i][0], t0: edit.map[i][1], o1: m[0], t1: m[1], from: m[2] ?? 0 })).filter((m) => m.o1 > m.o0);
  // A leading hold sits behind the title and needs no frames.
  while (moves[0].t1 <= moves[0].t0) moves.shift();
  const proxyFrom = moves[0].o0;
  // Kept between runs for the same take and timing, so a change of type or framing costs a render and not a re-encode of the take.
  const proxy = path.join(os.tmpdir(), `tomrade-short-${createHash("sha1").update(takes + JSON.stringify(edit.map) + JSON.stringify(edit.smooth ?? [])).digest("hex").slice(0, 12)}.mp4`);
  const firsts = sources.map((_, i) => Math.max(0, Math.min(...moves.filter((m) => m.from === i).map((m) => m.t0), 1e9) - 1));
  const parts = moves.map((m, i) => {
    // A hold is a tenth of a second stretched out. A window capture makes no frames while nothing changes, so the
    // frame rate is made constant before cutting: a quiet stretch would otherwise come out short.
    const end = Math.max(m.t1, m.t0 + 0.1);
    // Frames counted from the film's own clock, not each part's length: rounded part by part, a long cut drifts early.
    const frames = Math.round(m.o1 * FPS) - Math.round(m.o0 * FPS);
    const smooth = (edit.smooth ?? []).some(([a, b]) => m.o0 >= a - 1e-6 && m.o1 <= b + 1e-6);
    // Interpolated at the size the film shows it, then back to the take's size so every part concatenates. The capture
    // claims 600 fps, which leaves minterpolate nothing to make, so it first gets a steady 24 near the real ~22; and
    // interpolation stops at the last real frame, so the part is padded to its full length or everything after runs early.
    if (smooth) return `[${m.from}:v]trim=start=${(m.t0 - firsts[m.from]).toFixed(4)}:end=${(end - firsts[m.from]).toFixed(4)},setpts=(PTS-STARTPTS)/${((end - m.t0) / (m.o1 - m.o0)).toFixed(5)},fps=24,scale=4224:-2,minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,setpts=PTS-STARTPTS,fps=${FPS},scale=${size.width}:${size.height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames}[p${i}]`;
    return `[${m.from}:v]fps=${FPS},trim=start=${(m.t0 - firsts[m.from]).toFixed(4)}:end=${(end - firsts[m.from]).toFixed(4)},setpts=(PTS-STARTPTS)/${((end - m.t0) / (m.o1 - m.o0)).toFixed(5)},fps=${FPS},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS[p${i}]`;
  });
  if (!fs.existsSync(proxy)) ff([...sources.flatMap((file, i) => ["-ss", String(firsts[i]), "-i", file]), "-filter_complex", `${parts.join(";")};${moves.map((_, i) => `[p${i}]`).join("")}concat=n=${moves.length}:v=1:a=0,fps=${FPS},format=yuv420p[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-g", "1", `${proxy}.part.mp4`]);
  if (fs.existsSync(`${proxy}.part.mp4`)) fs.renameSync(`${proxy}.part.mp4`, proxy);

  // Where the window sits on the stage at time t.
  const cameraAt = (t) => {
    const keys = edit.cam;
    let was = edit.shots[keys[0][1]];
    let cut = was.top ?? 0;
    for (const key of keys.slice(1)) {
      const next = edit.shots[key[1]];
      const from = key[0] - (key[2] ?? 0.6);
      if (t >= key[0]) { was = next; cut = next.top ?? 0; continue; }
      const p = ease((t - from) / (key[0] - from));
      // both shots spotlit: the rectangle changes at the move's middle; otherwise the one there is, fading
      const spot = was.spot && next.spot ? (p < 0.5 ? was.spot : next.spot) : (next.spot ?? was.spot ?? null);
      return { x: lerp(was.x, next.x, p), y: lerp(was.y, next.y, p), w: lerp(was.w, next.w, p), veil: lerp(was.veil ?? 0, next.veil ?? 0, p), veilTop: lerp(was.veilTop ?? 0, next.veilTop ?? 0, p), top: p < 0.5 ? cut : (next.top ?? 0),
        spot, spotIn: next.spot && was.spot ? 1 : next.spot ? p : was.spot ? 1 - p : 0 };
    }
    return { ...was, top: cut, spot: was.spot ?? null, spotIn: was.spot ? 1 : 0 };
  };
  const typeAt = (c, t, to = c.to) => {
    const arrive = out3((t - (c.from ?? c.at)) / 0.22);
    return { ...c, opacity: Math.min(arrive, clamp((to - t) / 0.14)), dy: 28 * (1 - arrive), hot: c.hotTo !== undefined && t < c.hotTo };
  };
  // The opening's crowd: five bots pop in round you, then step closer on the beat.
  const STAGE = { x: 1400, y: 540 };
  const SEATS = [-90, -18, 54, 126, 198].map((a) => (a * Math.PI) / 180);
  const BUBBLES = [[0, -128], [118, -96], [104, 128], [-104, 128], [-118, -96]];
  const crowdAt = (t, a) => {
    const step = a.steps.reduce((sum, at) => sum + out3((t - at) / 0.16), 0);
    const r = 300 - 25 * step;
    const beatBob = Math.abs(Math.sin((Math.PI * t) / a.beat)) * 6;
    const bots = SEATS.map((seat, i) => ({
      x: STAGE.x + Math.cos(seat) * r,
      y: STAGE.y + Math.sin(seat) * r - beatBob,
      k: pop((t - a.at[i]) / 0.24),
      lookX: -Math.cos(seat),
      lookY: -Math.sin(seat),
      bx: STAGE.x + Math.cos(seat) * r + BUBBLES[i][0],
      by: STAGE.y + Math.sin(seat) * r + BUBBLES[i][1] - beatBob,
      q: pop((t - a.at[i] - 0.1) / 0.2),
      side: Math.sign(BUBBLES[i][0]),
      line: a.lines[i]
    }));
    const nerves = clamp(step);
    if (a.asleep) {
      // Three z's drifting up and fading, one after another, forever.
      const zs = [0, 1, 2].map((i) => { const p = (t / 1.6 + i / 3) % 1; return { x: 58 + 26 * p, y: -60 - 70 * p, size: 26 + 16 * p, o: Math.sin(Math.PI * p) }; });
      return { bots, you: { x: STAGE.x, y: STAGE.y + Math.sin(t * 2.2) * 3, k: 1 + 0.015 * Math.sin(t * 2.2), asleep: true, zs } };
    }
    return { bots, you: { x: STAGE.x + Math.sin(t * 58) * 2.6 * nerves, y: STAGE.y, k: 1 - 0.05 * step, sweat: nerves } };
  };
  // Tickets in place of the crowd: each drops from above the stage, lands with a little bounce, and squashes you a bit
  // more; the lower ones land round your body and the upper ones on your head, leaving only your eyes between them.
  const PILE = [[-110, 708, -9], [115, 700, 8], [0, 728, -3], [-30, 484, 7], [60, 424, -12]];
  const pileAt = (t, a) => {
    const you = { x: STAGE.x, y: 600 };
    let hits = 0;
    const cards = a.at.map((at, i) => {
      const [dx, y, rot] = PILE[i % PILE.length];
      const p = (t - at) / 0.3;
      if (p <= 0) return null;
      const landed = p >= 1;
      if (landed) hits += clamp((t - at - 0.3) / 0.12);
      const since = t - at - 0.3;
      const bounce = landed ? -Math.abs(Math.sin(since * 18)) * 22 * Math.exp(-since * 9) : 0;
      return { x: you.x + dx, y: landed ? y + bounce : -140 + (y + 140) * p * p, rot: landed ? rot : rot * 2.4 * (1 - p) + rot, key: a.cards[i].key, title: a.cards[i].title, line: a.lines[i] };
    }).filter(Boolean);
    // each landing knocks you down a little, and you spring part of the way back
    const sq = a.at.reduce((s, at) => { const d = t - at - 0.3; return d < 0 ? s : s - 0.05 - 0.09 * Math.exp(-d * 10); }, 1);
    return { bots: [], you: { x: you.x, y: you.y + (1 - sq) * 40, k: 1, sq: Math.max(0.62, sq), sweat: clamp(hits / 2) }, pile: cards };
  };
  // A mailbox in place of the crowd, the bots in a queue behind it: each letter drifts down swaying and turning, and
  // slips into the slot; the flag goes up with the first, and the queue watches whichever letter is falling.
  const MAIL = { x: 1150, y: 560, slot: 530, fall: 0.8 };
  const mailboxAt = (t, a) => {
    const letters = [];
    let bump = 0, watching = null;
    a.at.forEach((at, i) => {
      const p = (t - at) / MAIL.fall;
      const arrived = t - at - MAIL.fall;
      if (arrived >= 0) bump += Math.exp(-arrived * 12) * Math.sin(Math.min(Math.PI, arrived * 28));
      if (p <= 0 || p >= 1.18) return;
      const q = clamp(p);
      const sway = Math.sin(q * Math.PI * 2.2 + i) * 70 * (1 - q);
      const lx = MAIL.x + sway, ly = -90 + (MAIL.slot - 40 + 90) * (1 - (1 - q) * (1 - q));
      const into = clamp((p - 1) / 0.18);
      letters.push({ x: lx, y: ly + 40 * into, rot: Math.sin(q * Math.PI * 1.6 + i * 1.3) * 28 * (1 - q), sy: 1 - into, line: a.lines[i] });
      if (p < 1) watching = { x: lx, y: ly };
    });
    const flag = 90 - 90 * out3((t - a.at[0] - MAIL.fall) / 0.25);
    const bots = [0, 1, 2, 3, 4].map((i) => {
      const x = 1370 + i * 122, y = 690 - i * 8 - Math.abs(Math.sin((Math.PI * (t + i * 0.12)) / 0.46875)) * 5;
      const look = watching ? { x: watching.x - x, y: watching.y - y } : { x: -1, y: -0.2 };
      const d = Math.hypot(look.x, look.y) || 1;
      return { x, y, k: 0.78 * pop((t - 0.05 - i * 0.06) / 0.24), lookX: look.x / d, lookY: look.y / d, q: 0 };
    });
    return { bots, you: null, mailbox: { x: MAIL.x, y: MAIL.y, bump, flag, letters } };
  };
  // A git graph in place of the crowd: your trunk runs along the bottom, and on each beat a half-done branch grows off
  // it, ends in a tag that sulks at you, and droops a little more the longer it is left.
  const TAGS = [[1170, 250], [1640, 220], [1290, 450], [1700, 460], [1460, 640]];
  const COLORS = ['#c4492c', '#5b4fc4', '#2f9e6e', '#d68a1c', '#3a7bd5'];
  const branchesAt = (t, a) => {
    const trunkY = 800;
    const list = a.at.map((at, i) => {
      const [tx, ty] = TAGS[i % TAGS.length];
      const sx = tx - 110, sy = trunkY, ey = ty + 50;
      const grow = clamp((t - at) / 0.32);
      const path = 'M' + sx + ' ' + sy + ' C' + sx + ' ' + (sy - 140) + ' ' + tx + ' ' + (ey + 160) + ' ' + tx + ' ' + ey;
      const sulk = clamp((t - at - 0.5) / 1.6);
      return { path, sx, sy, mx: (sx + tx) / 2, my: (sy + ey) / 2, color: COLORS[i % COLORS.length], grow, tx, ty, q: pop((t - at - 0.24) / 0.24), rot: (i % 2 ? 1 : -1) * (2 + 7 * sulk), name: a.names[i], line: a.lines[i], zh: a.zh[i] };
    }).filter((b) => b.grow > 0);
    const nerves = clamp(list.length / 3);
    return { bots: [], you: null, branches: { trunk: ['1000 ' + trunkY, '1900 ' + trunkY], you: { x: 1010 + Math.sin(t * 58) * 2 * nerves, y: trunkY - 10, k: 0.8, sweat: nerves }, list } };
  };
  // A folder in place of the crowd: a note, a document and a diagram each arc in on its beat and drop inside; the folder
  // bumps and glows as each lands.
  const FOLDER = { x: 1420, y: 640 };
  const START = [[1180, 220, -14], [1420, 150, 6], [1660, 220, 12]];
  const folderAt = (t, a) => {
    let bump = 0, glow = 0;
    const front = [], back = [];
    a.at.forEach((at, i) => {
      const [sx, sy, rot] = START[i % START.length];
      const land = t - at - 0.55;
      if (land >= 0) { bump += Math.exp(-land * 10) * Math.sin(Math.min(Math.PI, land * 24)); glow = Math.max(glow, Math.exp(-land * 2.5)); }
      const shown = pop((t - at) / 0.25);
      if (shown <= 0) return;
      const p = clamp((t - at - 0.25) / 0.3);
      const e = p * p;
      const item = { x: sx + (FOLDER.x + (i - 1) * 60 - sx) * e, y: sy + (FOLDER.y - 40 - sy) * e - Math.sin(Math.PI * p) * 50, rot: rot * (1 - e), k: shown * (1 - 0.25 * e), kind: a.items[i].kind, name: a.items[i].name };
      // halfway down it slips behind the folder's front
      (p > 0.75 ? back : front).push(item);
    });
    return { bots: [], you: null, folder: { x: FOLDER.x, y: FOLDER.y, bump, glow, front, back } };
  };
  // Plugin tiles in place of the crowd: each flies in from the right on its beat and snaps into a 3×2 grid with a bounce.
  const tilesAt = (t, a) => {
    const tiles = a.items.map((item, i) => {
      const p = clamp((t - a.at[i]) / 0.32);
      if (p <= 0) return null;
      const col = i % 3, row = Math.floor(i / 3);
      const tx = 1180 + col * 250, ty = 400 + row * 196;
      const e = out3(p);
      const since = t - a.at[i] - 0.32;
      return { x: 2100 + (tx - 2100) * e, y: ty - 260 * (1 - e) + (since > 0 ? Math.sin(since * 20) * 10 * Math.exp(-since * 9) : 0), rot: 24 * (1 - e) * (i % 2 ? -1 : 1), k: 0.6 + 0.4 * e, lit: since > 0 ? Math.exp(-since * 4) : 0, icon: item.icon, name: item.name };
    }).filter(Boolean);
    return { bots: [], you: null, tiles };
  };
  // One sentence in place of the crowd: it pops up, gives way to tickets that fly out of it, and arrows link them.
  const IDEA_X = [1120, 1440, 1760];
  const ideaAt = (t, a) => {
    const last = a.cards[0]?.at ?? Infinity;
    const cards = a.cards.map((c, i) => {
      const p = clamp((t - c.at) / 0.34);
      if (p <= 0) return null;
      const e = out3(p);
      return { x: 1440 + (IDEA_X[i] - 1440) * e, y: 360 + (660 - 360) * e, k: pop((t - c.at) / 0.3), key: c.key, title: c.title };
    }).filter(Boolean);
    const links = a.links.map((l) => ({ x1: IDEA_X[l.from] + 142, x2: IDEA_X[l.to] - 142, y: 660, p: clamp((t - l.at) / 0.25) })).filter((l) => l.p > 0);
    return { bots: [], you: null, idea: { said: a.said, bubble: pop((t - a.at) / 0.3), fade: 1 - 0.55 * clamp((t - last) / 0.4), cards, links } };
  };
  // A phone in place of the crowd: the chat with Tomrade fills in, a bubble per beat.
  const chatAt = (t, a) => ({ bots: [], you: null, chat: { lines: a.lines.filter((l) => t >= l.at).map((l) => ({ ...l, q: pop((t - l.at) / 0.22) })) } });
  // A terminal in place of the crowd: the command types itself, and each line Tomrade adds pops in on its beat.
  const terminalAt = (t, a) => {
    const n = Math.round(a.command.length * clamp((t - a.typeFrom) / (a.typeTo - a.typeFrom)));
    const shown = a.lines.map((l) => ({ ...l, q: out3((t - l.at) / 0.2) })).filter((l) => l.q > 0);
    return { k: pop((t - a.at) / 0.3), typed: a.command.slice(0, n), caret: !shown.length && Math.floor(t / 0.3) % 2 === 0, lines: shown };
  };
  const stateAt = (t) => {
    const c = cameraAt(t);
    const shown = view.h - (c.top ?? 0);
    const win = { x: c.x, y: c.y, w: c.w, h: (c.w * shown) / view.w };
    const k = win.w / view.w;
    const tt = edit.title;
    // A card rises in (the title is already there) and lifts away on the last half second before its cut, on the beat.
    const card = [{ from: 0, ...edit.title }, ...(edit.cards ?? [])].find((c) => t >= c.from && t < c.to);
    const since = card ? t - card.from : 0;
    const title = card ? { y: (card.from ? H * (1 - ease(since / 0.42)) : 0) - H * ease((t - (card.to - 0.42)) / 0.42), dusk: card.dusk, blocks: card.blocks.filter((b) => since >= b.at).map((b) => typeAt(b, since, Infinity)), ...(card.agents ? crowdAt(since, card.agents) : card.pile ? pileAt(since, card.pile) : card.mailbox ? mailboxAt(since, card.mailbox) : card.branches ? branchesAt(since, card.branches) : card.folder ? folderAt(since, card.folder) : card.tiles ? tilesAt(since, card.tiles) : card.chat ? chatAt(since, card.chat) : card.idea ? ideaAt(since, card.idea) : { bots: [], you: null }), terminal: card.terminal ? terminalAt(since, card.terminal) : null } : null;
    const en = edit.end;
    const end = t >= en.from ? { opacity: ease((t - en.from) / 0.26), en: en.en, zh: en.zh, url: en.url, in: ease((t - en.from - 0.1) / 0.3) } : null;
    const flashes = (edit.flashes ?? []).filter((f) => t >= f.t && t < (f.to ?? f.t) + 0.55 && edit.cells?.[f.cell]).map((f) => { const r = edit.cells[f.cell]; return { x: win.x + r.x * k, y: win.y + (r.y - top - (c.top ?? 0)) * k, w: r.w * k, h: r.h * k, alpha: f.to ? Math.min(1, clamp((f.to + 0.3 - t) / 0.3)) : 1 - (t - f.t) / 0.55 }; });
    // The take on screen now, by the map's segment: a card grid belongs to one take only.
    const seg = edit.map.findIndex((m, i) => i > 0 && t < m[0] && t >= edit.map[i - 1][0]);
    const source = seg > 0 ? (edit.map[seg][2] ?? 0) : (edit.map.at(-1)[2] ?? 0);
    const cards = edit.cardgrid && source === edit.cardgrid.source ? edit.cardgrid.cells.map((r) => ({ x: win.x + r.x * k, y: win.y + (r.y - top - (c.top ?? 0)) * k, w: r.w * k, h: r.h * k, bar: (edit.cardgrid.bar ?? 75) * k, title: r.title, zh: r.zh })) : null;
    const fast = (edit.fast ?? []).find((f) => t >= f.from && t < f.to);
    return {
      time: Math.max(0, t - proxyFrom),
      veil: c.veil ?? 0,
      veilTop: c.veilTop ?? 0,
      spot: c.spot ? { r: c.spot, a: c.spotIn } : null,
      stage: (edit.stages ?? []).filter((x) => x[0] <= t).at(-1)?.[1] ?? "paper",
      win,
      src: { x: 0, y: (top + (c.top ?? 0)) * scale, w: view.w * scale, h: shown * scale },
      texts: (edit.texts ?? []).filter((x) => t >= x.from && t < x.to).map((x) => typeAt(x, t)),
      fast: { label: fast ? `▶▶ ${fast.label}` : "", in: fast ? Math.min(clamp((t - fast.from) / 0.2), clamp((fast.to - t) / 0.2)) : 0 },
      title, end, flashes, cards
    };
  };

  const page = new BrowserWindow({ width: W * OUT, height: H * OUT, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, autoplayPolicy: "no-user-gesture-required" } });
  page.webContents.setFrameRate(240);
  page.webContents.on("console-message", (event) => event.level === "error" && console.error(`[page] ${event.message} @${event.lineNumber}`));
  const html = path.join(tmp, "page.html");
  fs.writeFileSync(html, PAGE(pathToFileURL(proxy).href, pathToFileURL(path.join(dir, "../assets/icon.png")).href));
  page.webContents.on("dom-ready", () => page.webContents.setZoomFactor(OUT));
  await page.loadFile(html);
  page.webContents.setZoomFactor(OUT);
  await page.webContents.executeJavaScript(`new Promise((r) => { const v = document.querySelector('video'); v.readyState >= 2 ? r(true) : v.addEventListener('loadeddata', () => r(true), { once: true }); })`, true);

  const stills = process.env.FILM_STILLS?.split(",").map(Number);
  if (stills) {
    for (const t of stills) {
      // Twice, because after a jump the first capture can still hold the frame before it.
      for (let i = 0; i < 2; i++) await page.webContents.executeJavaScript(`frame(${JSON.stringify(stateAt(t))})`, true);
      fs.writeFileSync(`${out}.${t.toFixed(2)}.png`, (await page.webContents.capturePage()).resize({ width: W * OUT, height: H * OUT }).toPNG());
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  const total = Math.round(edit.seconds * FPS);
  const raw = path.join(tmp, "video.mp4");
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W * OUT}x${H * OUT}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", raw], { stdio: ["pipe", "inherit", "inherit"] });
  const write = (buffer) => new Promise((r) => (ffmpeg.stdin.write(buffer) ? r() : ffmpeg.stdin.once("drain", r)));
  const started = Date.now();
  // The first capture can still hold the page as it loaded, before any frame was drawn: draw the opening once unrecorded.
  await page.webContents.executeJavaScript(`frame(${JSON.stringify(stateAt(0))})`, true);
  for (let i = 0; i < total; i++) {
    await page.webContents.executeJavaScript(`frame(${JSON.stringify(stateAt(i / FPS))})`, true);
    const image = await page.webContents.capturePage();
    await write(image.resize({ width: W * OUT, height: H * OUT }).toBitmap());
    if (i % 240 === 0) console.log(`frame ${i}/${total} · ${((Date.now() - started) / Math.max(1, i)).toFixed(0)} ms a frame`);
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on("close", r));

  const sound = path.join(tmp, "sound.wav");
  mix(sound, edit.seconds, edit.sfx ?? [], { music: edit.music ?? 0.8, sections: edit.sections ?? [] });
  ff(["-i", raw, "-i", sound, "-c:v", "copy", "-af", "loudnorm=I=-15:TP=-1.5:LRA=9", "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`rendered ${out}: ${edit.seconds} s`);
}

app.whenReady().then(run).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
