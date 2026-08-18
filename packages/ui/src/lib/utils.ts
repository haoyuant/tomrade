import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names (shadcn-compatible). Harvested from pm-tool/tomrade legacy. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Short relative-time formatter for cards (epoch ms). */
export function timeAgo(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (Number.isNaN(secs)) return "";
  const abs = Math.abs(secs);
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.34524, "w"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let value = abs;
  let unit = "s";
  for (const [div, label] of units) {
    if (value < div) {
      unit = label;
      break;
    }
    value /= div;
    unit = label;
  }
  const rounded = Math.round(value);
  return secs < 0 ? `in ${rounded}${unit}` : `${rounded}${unit} ago`;
}
