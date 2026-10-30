import { defaultFilter } from "cmdk";

/**
 * The first keyword of a ⌘K row for what ran before. The keywords after it, its title and ticket, are all it is found
 * by: a fuzzy match on whatever it last said lists conversations that have nothing to do with the words typed.
 */
export const LOOK_BACK = "\u0000look-back";

/** ⌘K's filter: what ran before matches only by its title or ticket, and always ranks below every other row. */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  if (keywords?.[0] !== LOOK_BACK) {
    const score = defaultFilter(value, search, keywords);
    return score > 0 ? 0.5 + score / 2 : 0;
  }
  const by = keywords.slice(1).join(" ");
  const said = by.toLowerCase();
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !terms.every((term) => said.includes(term))) return 0;
  return (defaultFilter(by, search) || 0.01) / 2;
}
