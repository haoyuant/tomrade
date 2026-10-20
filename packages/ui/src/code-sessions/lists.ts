import type { SessionRow } from "@tomradex/code-sessions";

/** A live session this window cannot show: it runs in another terminal app here, or on another computer. */
export const away = (s: SessionRow): boolean => s.endedAt === null && !s.pane && (s.where === "outside" || s.where === "elsewhere");

/** The sidebar's two lists of live sessions: the ones this window shows or Tomrade runs, and the ones it cannot show. Ended ones are the archive's. */
export function sessionGroups(sessions: SessionRow[]): { here: SessionRow[]; away: SessionRow[] } {
  const live = sessions.filter((s) => s.endedAt === null);
  return { here: live.filter((s) => !away(s)), away: live.filter(away) };
}

/** Folds the sidebar: ⌘B on a Mac, as in the app; Ctrl+Shift+B elsewhere, where Ctrl+B is the shell's and tmux's. */
export const foldChord = (mac: boolean): string => (mac ? "Mod+B" : "Mod+Shift+B");
