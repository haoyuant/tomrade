/**
 * Tomrade design system — dual theme (light default, .dark overrides).
 * Semantic tokens only: surfaces, borders, text, buttons, inputs, status colors.
 */

export const SURFACE = {
  page: "bg-slate-50 dark:bg-slate-950",
  card: "bg-white dark:bg-slate-900",
  elevated: "bg-slate-100 dark:bg-slate-800",
} as const;

export const BORDER = {
  default: "border-slate-200 dark:border-slate-800",
  subtle: "border-slate-300 dark:border-slate-700",
} as const;

export const TEXT = {
  heading: "text-slate-900 dark:text-slate-100",
  body: "text-slate-800 dark:text-slate-200",
  muted: "text-slate-700 dark:text-slate-300",
  subtle: "text-slate-500 dark:text-slate-400",
} as const;

/** Shared button base: geometry, focus ring, disabled, transitions. */
export const BTN_BASE =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:cursor-not-allowed disabled:opacity-50";

export const BTN = {
  primary: BTN_BASE + " bg-sky-600 text-white shadow-sm hover:bg-sky-500 active:bg-sky-700",
  secondary:
    BTN_BASE +
    " bg-slate-200 text-slate-800 hover:bg-slate-300 active:bg-slate-400/60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:active:bg-slate-600",
  ghost:
    BTN_BASE +
    " text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
  danger: BTN_BASE + " bg-red-600 text-white shadow-sm hover:bg-red-500 active:bg-red-700",
  icon: BTN_BASE + " !px-2 !py-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
} as const;

export const INPUT =
  "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";

/** Human-owned workflow_status (the board's columns). */
export const WORKFLOW_STATUS: Record<string, { label: string; color: string }> =
  {
    backlog: { label: "Backlog", color: "text-slate-500 dark:text-slate-400" },
    todo: { label: "To Do", color: "text-sky-500 dark:text-sky-400" },
    doing: { label: "Doing", color: "text-amber-600 dark:text-amber-400" },
    verifying: { label: "Verifying", color: "text-purple-600 dark:text-purple-400" },
    done: { label: "Done", color: "text-emerald-600 dark:text-emerald-400" },
    cancelled: { label: "Cancelled", color: "text-slate-500 dark:text-slate-500" },
  };

export const WORKFLOW_STATUS_ORDER = [
  "backlog",
  "todo",
  "doing",
  "verifying",
  "done",
  "cancelled",
] as const;

export const TYPE_COLORS: Record<string, { label: string; color: string }> = {
  epic: { label: "Epic", color: "text-violet-600 dark:text-violet-400" },
  ticket: { label: "Ticket", color: "text-sky-600 dark:text-sky-400" },
};

export const PROVENANCE: Record<string, { label: string; badge: string }> = {
  ai: {
    label: "AI",
    badge: "bg-sky-100 border border-sky-200 text-sky-700 dark:bg-sky-950 dark:border-sky-900 dark:text-sky-300",
  },
  human: {
    label: "Human",
    badge: "bg-slate-200 border border-slate-300 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300",
  },
  locked: {
    label: "Locked",
    badge: "bg-amber-100 border border-amber-200 text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-300",
  },
};