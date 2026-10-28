const FENCE = /^ {0,3}(```|~~~)/m;
const HEADING = /^ {0,3}#{1,6}[ \t]+\S/m;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+\S/gm;
const STRONG = /(\*\*|__)(?=\S)[^\n]*?\S\1/;
const QUOTE = /^ {0,3}>[ \t]+\S/gm;

/**
 * Whether an engine's reply is written in Markdown: a fence, a heading, a table,
 * a list of two or more items, bold, or a quote of two lines. One stray dash or
 * an item key such as TOM-12 is plain text, which keeps its own look.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (FENCE.test(text) || HEADING.test(text) || TABLE_RULE.test(text) || STRONG.test(text)) return true;
  return (text.match(LIST_ITEM)?.length ?? 0) >= 2 || (text.match(QUOTE)?.length ?? 0) >= 2;
}
