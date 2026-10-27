import type * as React from "react";

/**
 * The icon sprite, verbatim from the design: inline SVG only, never emoji.
 * Mounted once at the app root; every icon is a <use href="#id" />.
 */
export const ICON_IDS = [
  "i-board",
  "i-keyboard",
  "i-stack",
  "i-home",
  "i-back",
  "i-sun",
  "i-moon",
  "i-leaf",
  "i-bug",
  "i-bars",
  "i-plus",
  "i-gear",
  "i-undo",
  "i-redo",
  "i-sync",
  "i-search",
  "i-chev",
  "i-chevdown",
  "i-expand",
  "i-shrink",
  "i-archive",
  "i-close",
  "i-lock",
  "i-trash",
  "i-panel",
  "i-warn",
  "i-filter",
  "i-plug",
  "i-monitor",
  "i-globe",
  "i-cloud",
  "i-cloud-half",
  "i-eye",
  "i-eye-off",
  "i-check",
  "i-tag",
  "i-pen",
  "i-sliders",
  "i-clock",
  "i-tomato",
  "i-history",
  "i-alarm",
  "i-send",
  "i-stop",
  "i-graph",
  "i-branch",
  "i-merge",
  "i-terminal",
  "i-folder",
  "i-file",
  "i-upload",
  "i-download",
  "i-info",
  "i-copy",
  "i-cut",
  "i-paste",
  "i-link",
  "i-calendar",
  "i-split",
  "i-popout",
  "i-inbox",
  "i-grid",
  "i-cards",
  "s-backlog",
  "s-todo",
  "s-doing",
  "s-verifying",
  "s-done",
  "s-cancelled",
  "p-0",
  "p-1",
  "p-2",
  "p-3",
  "p-4",
] as const;

export type IconId = (typeof ICON_IDS)[number];

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="i-board" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="2" width="4" height="10" rx="1"/><rect x="8.5" y="2" width="4" height="6.5" rx="1"/></g></symbol>
        <symbol id="i-stack" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M7 1.8 12.4 4.6 7 7.4 1.6 4.6Z"/><path d="M1.6 7.6 7 10.4l5.4-2.8"/></g></symbol>
        <symbol id="i-home" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.1 6.3 7 2.1l4.9 4.2v5a.9.9 0 0 1-.9.9H3a.9.9 0 0 1-.9-.9Z"/><path d="M5.6 12.2V8.3h2.8v3.9"/></g></symbol>
        <symbol id="i-back" viewBox="0 0 14 14"><path d="M8.8 3.4 5.1 7l3.7 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-sun" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="7" cy="7" r="2.7"/><path d="M7 1.2v1.4M7 11.4v1.4M12.8 7h-1.4M2.6 7H1.2M11.1 2.9l-1 1M3.9 10.1l-1 1M11.1 11.1l-1-1M3.9 3.9l-1-1"/></g></symbol>
        <symbol id="i-moon" viewBox="0 0 14 14"><path d="M11.6 8.6A5.2 5.2 0 0 1 5.4 2.4a5.2 5.2 0 1 0 6.2 6.2Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></symbol>
        <symbol id="i-leaf" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11.8 2.4C6.6 2 2.6 4 2.6 8a3.6 3.6 0 0 0 3.6 3.6c4 0 5.9-4.1 5.6-9.2Z"/><path d="M9.6 4.6 4.4 10.4"/></g></symbol>
        <symbol id="i-bug" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><rect x="4.2" y="4.4" width="5.6" height="7" rx="2.8"/><path d="M4.2 7H1.8M12.2 7H9.8M4.6 4.9 2.8 3.1M9.4 4.9l1.8-1.8M4.4 10.2 2.6 11.6M9.6 10.2l1.8 1.4"/></g></symbol>
        <symbol id="i-bars" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="8.4" width="2.6" height="3.6" rx="0.7"/><rect x="5.7" y="5.8" width="2.6" height="6.2" rx="0.7"/><rect x="9.4" y="3.2" width="2.6" height="8.8" rx="0.7"/></g></symbol>
        <symbol id="i-plus" viewBox="0 0 14 14"><path d="M7 2.6v8.8M2.6 7h8.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></symbol>
        <symbol id="i-gear" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round"><circle cx="7" cy="7" r="4.15"/><circle cx="7" cy="7" r="1.8"/><path d="M11.15 7H12.75M7 2.85V1.25M2.85 7H1.25M7 11.15V12.75M9.94 4.06 11.07 2.93M4.06 4.06 2.93 2.93M4.06 9.94 2.93 11.07M9.94 9.94 11.07 11.07"/></g></symbol>
        <symbol id="i-undo" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.4 5.4h6.2a3.4 3.4 0 1 1 0 6.8H5.2"/><path d="M4.8 2.9 2.3 5.4l2.5 2.5"/></g></symbol>
        <symbol id="i-redo" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11.6 5.4H5.4a3.4 3.4 0 1 0 0 6.8h3.4"/><path d="M9.2 2.9l2.5 2.5-2.5 2.5"/></g></symbol>
        <symbol id="i-sync" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.3 7.2a4.7 4.7 0 0 1 7.9-3.5"/><path d="M10.1 1.9v2.3H7.8"/><path d="M11.7 6.8a4.7 4.7 0 0 1-7.9 3.5"/><path d="M3.9 12.1V9.8h2.3"/></g></symbol>
        <symbol id="i-search" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="6.2" cy="6.2" r="3.9"/><path d="M9.2 9.2 12 12"/></g></symbol>
        <symbol id="i-send" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M11 3.2v3a1.8 1.8 0 0 1-1.8 1.8H3.4"/><path d="M5.8 5.6 3.4 8l2.4 2.4"/></g></symbol>
        <symbol id="i-stop" viewBox="0 0 14 14"><rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.2" fill="currentColor"/></symbol>
        <symbol id="i-chev" viewBox="0 0 14 14"><path d="M5.2 3.4 8.9 7l-3.7 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-chevdown" viewBox="0 0 14 14"><path d="M3.6 5.4 7 8.8l3.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-expand" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8.4 2.2h3.4v3.4M5.6 11.8H2.2V8.4M11.8 2.2 7.9 6.1M2.2 11.8l3.9-3.9"/></g></symbol>
        <symbol id="i-shrink" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M11.4 6.2H8V2.8M2.6 7.8H6v3.4M8 6.2l3.8-3.8M6 7.8l-3.8 3.8"/></g></symbol>
          <symbol id="i-archive" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.8" y="2.4" width="10.4" height="2.8" rx="0.8"/><path d="M2.9 5.2v5.6a.8.8 0 0 0 .8.8h6.6a.8.8 0 0 0 .8-.8V5.2M5.7 7.6h2.6"/></g></symbol>
        <symbol id="i-close" viewBox="0 0 14 14"><path d="M3.4 3.4 10.6 10.6M10.6 3.4 3.4 10.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></symbol>
        <symbol id="i-lock" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.15"><rect x="3.3" y="6.2" width="7.4" height="5.4" rx="1.2"/><path d="M5.1 6.2V4.7a1.9 1.9 0 0 1 3.8 0v1.5"/></g></symbol>
        <symbol id="i-panel" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.6" y="2.4" width="10.8" height="9.2" rx="1.4"/><path d="M8.6 2.4v9.2"/></g></symbol>
        <symbol id="i-trash" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.4 3.9h9.2"/><path d="M5.6 3.9V2.6a.7.7 0 0 1 .7-.7h1.4a.7.7 0 0 1 .7.7v1.3"/><path d="M3.5 3.9l.5 7.4a.9.9 0 0 0 .9.8h4.2a.9.9 0 0 0 .9-.8l.5-7.4"/><path d="M5.9 6.2v3.6M8.1 6.2v3.6"/></g></symbol>
        <symbol id="i-warn" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M7 1.9 12.9 12H1.1Z" strokeLinejoin="round"/><path d="M7 5.9v2.6M7 10.3v.1"/></g></symbol>
        <symbol id="i-filter" viewBox="0 0 14 14"><path d="M1.8 3.2h10.4L8.3 7.6v4l-2.6-1.4V7.6Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></symbol>
        <symbol id="i-plug" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M5.2 1.8v3M8.8 1.8v3M3.4 4.8h7.2v2.1a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6Z"/><path d="M7 10.5v1.7"/></g></symbol>
        <symbol id="i-monitor" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><rect x="1.6" y="2.4" width="10.8" height="7.4" rx="1.2"/><path d="M5 12.2h4"/></g></symbol>
        <symbol id="i-cloud" viewBox="0 0 14 14"><path d="M10.2 11.1H5.3a4.1 4.1 0 1 1 3.9-5.3h1a2.65 2.65 0 1 1 0 5.3Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></symbol>
        <symbol id="i-eye" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M1 7s2.3-3.9 6-3.9S13 7 13 7s-2.3 3.9-6 3.9S1 7 1 7Z"/><circle cx="7" cy="7" r="1.7"/></g></symbol>
        <symbol id="i-eye-off" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"><path d="M1 7s2.3-3.9 6-3.9S13 7 13 7s-2.3 3.9-6 3.9S1 7 1 7Z"/><circle cx="7" cy="7" r="1.7"/><path d="M2.2 11.8 11.8 2.2"/></g></symbol>
        <symbol id="i-cloud-half" viewBox="0 0 14 14"><clipPath id="i-cloud-half-clip"><rect x="0" y="0" width="7" height="14"/></clipPath><path d="M10.2 11.1H5.3a4.1 4.1 0 1 1 3.9-5.3h1a2.65 2.65 0 1 1 0 5.3Z" fill="currentColor" clipPath="url(#i-cloud-half-clip)"/><path d="M10.2 11.1H5.3a4.1 4.1 0 1 1 3.9-5.3h1a2.65 2.65 0 1 1 0 5.3Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></symbol>
        <symbol id="i-globe" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.1"><circle cx="7" cy="7" r="5.2"/><ellipse cx="7" cy="7" rx="2.3" ry="5.2"/><path d="M1.9 7h10.2M2.6 4.1h8.8M2.6 9.9h8.8"/></g></symbol>
        <symbol id="i-check" viewBox="0 0 14 14"><path d="M2.9 7.4 5.7 10.2 11.1 4.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-tag" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M7.8 2.1h4.1v4.1l-5.7 5.7L2.1 7.8Z"/><circle cx="9.6" cy="4.4" r="0.85"/></g></symbol>
        <symbol id="i-pen" viewBox="0 0 14 14"><path d="M9.3 2.4 11.6 4.7 5.3 11 2.4 11.6 3 8.7Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-sliders" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M1.9 4.6h10.2M1.9 9.4h10.2"/></g><g fill="currentColor"><circle cx="5.2" cy="4.6" r="1.7"/><circle cx="9" cy="9.4" r="1.7"/></g></symbol>
        <symbol id="i-clock" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="7" cy="7" r="5.2"/><path d="M7 4.2V7l2 1.4"/></g></symbol>
        <symbol id="i-tomato" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.4 4.4C2.6 5 1.4 6.6 1.4 8.5c0 2.5 2.5 4.3 5.6 4.3s5.6-1.8 5.6-4.3c0-1.9-1.2-3.5-3-4.1"/><path d="M7 3.7 5 3l1 1.2-2.4.6 2.3.3L7 6.2l1.1-1.1 2.3-.3-2.4-.6L9 3Z"/><path d="M7 3.7V1.6"/></g></symbol>
        <symbol id="i-history" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M1.9 7a5.1 5.1 0 1 0 5.1-5.1 5.6 5.6 0 0 0-3.9 1.6L1.9 4.7"/><path d="M1.9 1.9v2.8h2.8"/><path d="M7 4.3V7l1.9 1.1"/></g></symbol>
        {/* routines: an alarm clock, apart from the plain clock (dates, Recently updated) and History */}
        <symbol id="i-alarm" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="7.6" r="4.4"/><path d="M7 5.4v2.2l1.5.9"/><path d="M1.7 3.7 3.6 1.9M12.3 3.7 10.4 1.9"/><path d="M3.9 11 2.9 12.2M10.1 11l1 1.2"/></g></symbol>
        <symbol id="i-graph" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="3.2" cy="3.4" r="1.7"/><circle cx="10.8" cy="5.4" r="1.7"/><circle cx="5.6" cy="10.6" r="1.7"/><path d="M4.8 4 9.2 4.9M4.4 9.2 3.5 5.1M7.2 9.9 9.7 6.8" strokeLinecap="round"/></g></symbol>
        {/* code: a branch leaving the line, a pull request coming back, a prompt, a folder */}
        <symbol id="i-branch" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="3.6" cy="3.2" r="1.5"/><circle cx="3.6" cy="10.8" r="1.5"/><circle cx="10.4" cy="4.6" r="1.5"/><path d="M3.6 4.7v4.6M10.4 6.1c0 2.4-2.4 3-4.6 3.2"/></g></symbol>
        <symbol id="i-inbox" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M1.8 7.6 3.4 2.9a.8.8 0 0 1 .8-.5h5.6a.8.8 0 0 1 .8.5l1.6 4.7v3a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z"/><path d="M1.8 7.6h3l.8 1.6h2.8l.8-1.6h3"/></g></symbol>
        <symbol id="i-merge" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="3.6" cy="3.2" r="1.5"/><circle cx="3.6" cy="10.8" r="1.5"/><circle cx="10.4" cy="10.8" r="1.5"/><path d="M3.6 4.7v4.6M10.4 9.3V7.2a2.4 2.4 0 0 0-2.4-2.4H6.2M7.6 3.2 6 4.8l1.6 1.6"/></g></symbol>
        <symbol id="i-terminal" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="1.6" y="2.4" width="10.8" height="9.2" rx="1.2"/><path d="M4 5.4 6 7.2 4 9M7.6 9h2.6"/></g></symbol>
        <symbol id="i-file" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M3.4 1.8h4.9l3.3 3.3v7.1a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M8.3 1.8v3.3h3.3"/></g></symbol>
        <symbol id="i-upload" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9.4V2.4M4.3 5.1 7 2.4l2.7 2.7"/><path d="M2.2 9.6v1.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V9.6"/></g></symbol>
        <symbol id="i-download" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 2.4v7M4.3 6.7 7 9.4l2.7-2.7"/><path d="M2.2 9.6v1.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V9.6"/></g></symbol>
        <symbol id="i-info" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="7" cy="7" r="5.4"/><path d="M7 6.3v3.6M7 4.2v.1"/></g></symbol>
        {/* keyboard shortcuts: a keyboard, keys and a space bar */}
        <symbol id="i-keyboard" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="1.4" y="3.4" width="11.2" height="7.2" rx="1.2"/><path d="M3.8 5.6h.01M6 5.6h.01M8 5.6h.01M10.2 5.6h.01M4.8 8.4h4.4"/></g></symbol>
        <symbol id="i-folder" viewBox="0 0 14 14"><path d="M1.8 3.6a1 1 0 0 1 1-1h2.7l1.3 1.4h4.4a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></symbol>
        <symbol id="i-copy" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><rect x="4.6" y="4.6" width="7.4" height="7.4" rx="1"/><path d="M2.4 9.4V2.4a1 1 0 0 1 1-1h7"/></g></symbol>
        {/* notes: a link between two of them, a day */}
        <symbol id="i-link" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M6.1 7.9a2.4 2.4 0 0 0 3.4 0l2-2a2.4 2.4 0 0 0-3.4-3.4l-.9.9"/><path d="M7.9 6.1a2.4 2.4 0 0 0-3.4 0l-2 2a2.4 2.4 0 0 0 3.4 3.4l.9-.9"/></g></symbol>
        <symbol id="i-calendar" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2.8" width="10" height="9.2" rx="1.2"/><path d="M2 5.8h10M4.8 1.6v2.2M9.2 1.6v2.2"/></g></symbol>
        <symbol id="i-split" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.6" y="2.4" width="10.8" height="9.2" rx="1.4"/><path d="M7 2.4v9.2"/></g></symbol>
        <symbol id="i-grid" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.6" y="2.4" width="10.8" height="9.2" rx="1.4"/><path d="M7 2.4v9.2M1.6 7h10.8"/></g></symbol>
        <symbol id="i-cards" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.6" y="1.8" width="10.8" height="4.4" rx="1.2"/><rect x="1.6" y="7.8" width="10.8" height="4.4" rx="1.2"/></g></symbol>
        <symbol id="i-popout" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6.2 2.4H3a1.2 1.2 0 0 0-1.2 1.2V11A1.2 1.2 0 0 0 3 12.2h7.4a1.2 1.2 0 0 0 1.2-1.2V7.8"/><path d="M8.6 1.8h3.6v3.6M12.2 1.8 7 7"/></g></symbol>
        <symbol id="i-cut" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="3.4" cy="3.4" r="1.5"/><circle cx="3.4" cy="10.6" r="1.5"/><path d="M4.6 4.4 11.6 11M4.6 9.6 11.6 3"/></g></symbol>
        <symbol id="i-paste" viewBox="0 0 14 14"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><rect x="3.2" y="2.6" width="7.6" height="9.8" rx="1.1"/><rect x="5.2" y="1.4" width="3.6" height="1.8" rx="0.6"/><path d="M5 6.6h4M5 9h4" strokeLinecap="round"/></g></symbol>

        {/* status marks: shape-coded, legible without colour */}
        <symbol id="s-backlog" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2.1"/></symbol>
        <symbol id="s-todo" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3"/></symbol>
        <symbol id="s-doing" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M7 7V1.9A5.1 5.1 0 0 1 7 12.1Z" fill="currentColor"/></symbol>
        <symbol id="s-verifying" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M7 7V1.9A5.1 5.1 0 1 1 1.9 7Z" fill="currentColor"/></symbol>
        <symbol id="s-done" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6" fill="currentColor"/><path d="M4.5 7.1 6.3 8.9l3.2-3.6" fill="none" stroke="var(--surface)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="s-cancelled" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M4.6 9.4 9.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></symbol>
    
        {/* priority: bar height encodes level; urgent changes shape entirely */}
        <symbol id="p-0" viewBox="0 0 14 14"><rect x="3" y="6.4" width="8" height="1.5" rx="0.7" fill="currentColor" opacity="0.5"/></symbol>
        <symbol id="p-1" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="8.4" width="2.6" height="3.6" rx="0.7"/><rect x="5.7" y="5.8" width="2.6" height="6.2" rx="0.7" opacity="0.26"/><rect x="9.4" y="3.2" width="2.6" height="8.8" rx="0.7" opacity="0.26"/></g></symbol>
        <symbol id="p-2" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="8.4" width="2.6" height="3.6" rx="0.7"/><rect x="5.7" y="5.8" width="2.6" height="6.2" rx="0.7"/><rect x="9.4" y="3.2" width="2.6" height="8.8" rx="0.7" opacity="0.26"/></g></symbol>
        <symbol id="p-3" viewBox="0 0 14 14"><g fill="currentColor"><rect x="2" y="8.4" width="2.6" height="3.6" rx="0.7"/><rect x="5.7" y="5.8" width="2.6" height="6.2" rx="0.7"/><rect x="9.4" y="3.2" width="2.6" height="8.8" rx="0.7"/></g></symbol>
        <symbol id="p-4" viewBox="0 0 14 14"><rect x="1.6" y="1.6" width="10.8" height="10.8" rx="2.4" fill="currentColor"/><path d="M7 4.1v3.6" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round"/><circle cx="7" cy="9.9" r="0.9" fill="var(--surface)"/></symbol>
      </defs>
    </svg>
  );
}

export function Icon({ name, size = 14, className, ...rest }: { name: IconId; size?: number } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} className={className} {...rest}>
      <use href={`#${name}`} />
    </svg>
  );
}
