/** Past this many characters of JSON a result is too long to read whole. */
export const LONG_RESULT = 6000;
const LIST_CAP = 16000;
const TEXT_CAP = 160;

/** One row of a long list, shorn of what a listing does not need: empties, nested records, the tail of long text. */
export function compactRow(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v.length > TEXT_CAP ? v.slice(0, TEXT_CAP) + "…" : v;
    else if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x !== "object")) out[k] = v;
    } else if (typeof v !== "object") out[k] = v;
  }
  return out;
}

/**
 * A long list of records as a model should read it, or null when the result
 * is not one. A list that does not fit is not cut mid-record — that read as
 * "there is more, query again" and sent weaker models re-slicing the same rows
 * by status and sort — every row stays in a shortened form, and only past the
 * list cap do rows drop. `note` says which, and goes before the rows.
 */
export function compactList(result: unknown): { note: string; json: string } | null {
  if (!Array.isArray(result) || !result.length || !result.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))) return null;
  const rows = result.map(compactRow);
  let kept = rows.length;
  let json = JSON.stringify(rows);
  while (json.length > LIST_CAP && kept > 1) {
    kept = Math.min(kept - 1, Math.floor((kept * LIST_CAP) / json.length));
    json = JSON.stringify(rows.slice(0, kept));
  }
  const note = kept < rows.length
    ? `(${rows.length} items; showing the first ${kept} — narrow the search or use count_items)`
    : `(all ${rows.length} items; long text shortened and nested detail dropped — get_item for one item's full record)`;
  return { note, json };
}
