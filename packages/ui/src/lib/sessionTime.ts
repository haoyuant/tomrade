/** The words a time on a session card is said with: the app's own short units. */
export type TimeWords = (key: "domain.time_minutes" | "domain.time_hours", vars: { n: number }) => string;

/** How long, in the largest units that say it: "12m", "1h 5m"; never less than a minute. */
export function spanLabel(ms: number, say: TimeWords): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return say("domain.time_minutes", { n: mins });
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${say("domain.time_hours", { n: hours })} ${say("domain.time_minutes", { n: rest })}` : say("domain.time_hours", { n: hours });
}

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** When a session ran, as a clock reads it: "09:40–10:28". */
export const rangeLabel = (from: number, to: number): string => `${clock(from)}–${clock(to)}`;
