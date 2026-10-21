import { useState } from "react";
import { SLASH_COMMANDS } from "./commands";

/** The slash menu: open while the draft is `/` plus a partial name, until Esc. */
export function useSlashMenu(draft: string) {
  const [closed, setClosed] = useState(false);
  const [at, setAt] = useState(0);
  const term = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  const matches = term === undefined || closed ? [] : SLASH_COMMANDS.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(term)));
  const pick = matches[Math.min(at, matches.length - 1)];
  return { matches, pick, setAt, setClosed };
}
