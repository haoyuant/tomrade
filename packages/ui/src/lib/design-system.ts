/**
 * Tomrade design system (harvested from the legacy repo; simplified to the new
 * single-axis model: one workflow_status, kinds ticket/epic, provenance from
 * updatedBy/humanLocked). STYLING tokens only — no behavior, no data model.
 */

export const SURFACE = {
  page: "bg-slate-950",
  card: "bg-slate-900",
  elevated: "bg-slate-800",
} as const;

export const BORDER = {
  default: "border-slate-800",
  subtle: "border-slate-700",
} as const;

export const TEXT = {
  heading: "text-slate-100",
  body: "text-slate-200",
  muted: "text-slate-300",
  subtle: "text-slate-400",
} as const;

export const BTN = {
  primary: "bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50",
  secondary: "bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50",
  ghost: "text-slate-400 hover:text-slate-200 hover:bg-slate-800",
  danger: "bg-red-600/90 hover:bg-red-500 text-white disabled:opacity-50",
} as const;

export const INPUT =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:opacity-50";

/** Human-owned workflow_status (the board's columns). */
export const WORKFLOW_STATUS: Record<string, { label: string; color: string }> =
  {
    backlog: { label: "Backlog", color: "text-slate-400" },
    todo: { label: "To Do", color: "text-sky-400" },
    doing: { label: "Doing", color: "text-amber-400" },
    verifying: { label: "Verifying", color: "text-purple-400" },
    done: { label: "Done", color: "text-emerald-400" },
    cancelled: { label: "Cancelled", color: "text-slate-500" },
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
  epic: { label: "Epic", color: "text-violet-400" },
  ticket: { label: "Ticket", color: "text-sky-400" },
};

export const PROVENANCE: Record<string, { label: string; badge: string }> = {
  ai: {
    label: "AI",
    badge: "bg-sky-950 border border-sky-900 text-sky-300",
  },
  human: {
    label: "Human",
    badge: "bg-slate-800 border border-slate-700 text-slate-300",
  },
  locked: {
    label: "Locked",
    badge: "bg-amber-950 border border-amber-900 text-amber-300",
  },
};
