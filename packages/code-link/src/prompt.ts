/**
 * A permission prompt read off a pane's screen. Kept apart from the rest of code link, with nothing to import, so
 * the window that shows Allow and Deny reads a screen exactly as the answer that presses them does.
 */

/** How many of a pane's last lines hold the prompt Allow or Deny would answer. */
export const PROMPT_LINES = 30;

// The box edges an agent draws its prompt in.
const EDGE = /^[\s│┃║|]+|[\s│┃║|]+$/g;
/** The question asked before a tool runs: "Do you want to proceed?", "Allow command?", "Would you like to run the following command?". */
const ASKS = /(?:\b(?:do you want|would you like|allow|approve|proceed|permission|run)\b|允许|批准|执行).*[?？]$/i;
/** A folder's trust is not a tool's permission, and Enter there may well be "No, exit". */
const TRUST = /\btrust|信任/i;
/** An option: the cursor's mark, a number, or both, before its words. */
const OPTION = /^(?:([❯›▶➤>●])\s*)?(?:(\d+)[.)]\s+)?(\S.*)$/;
const YES = /^(?:yes|allow|approve|proceed|accept|always|run|允许|同意|批准|是)/i;
const NO = /^(?:no\b|deny|reject|decline|cancel|don'?t|拒绝|否|不)/i;

/**
 * The permission prompt on a pane's screen, read from its last lines: the option under the cursor, and whether it says
 * yes. Null when the screen asks nothing a key could safely answer: no such question, a folder's trust, or no choice
 * between yes and no under it.
 */
export function promptOnScreen(screen: string): { selected: string; allows: boolean } | null {
  const lines = screen.split("\n").map((l) => l.replace(EDGE, "")).filter(Boolean);
  // a narrow pane wraps the question onto a second line
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (ASKS.test(lines[i]!) || (i > 0 && ASKS.test(`${lines[i - 1]} ${lines[i]}`))) at = i;
  if (at < 0) return null;
  const block = lines.slice(Math.max(0, at - 1));
  if (block.some((l) => TRUST.test(l))) return null;
  let selected: string | null = null;
  let options = 0;
  let saysNo = false;
  for (const line of lines.slice(at + 1)) {
    const [, mark, number, text] = OPTION.exec(line) ?? [];
    if (!text || (!mark && !number)) continue;
    options++;
    if (NO.test(text)) saysNo = true;
    if (mark && selected === null) selected = text;
  }
  if (selected === null || options < 2 || !saysNo) return null;
  return { selected, allows: YES.test(selected) && !NO.test(selected) };
}
