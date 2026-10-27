import type { MenuItemConstructorOptions } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/projects";
import { errorMessage } from "@tomradex/contracts";

/** The Terminal window's own command: it opens the project's window, or brings it forward when it is open. */
export const TERMINAL_COMMAND = "code-sessions.open";
const MAX_PROJECTS = 6;

/** Whether this app has a Terminal window at all: the plugin that draws it registered its command. */
export function hasTerminalWindow(ctx: Context): boolean {
  return !!ctx.get("contributions")?.commands().some((c) => c.id === TERMINAL_COMMAND);
}

/** The projects a menu offers a Terminal window for: those on this machine, most recently changed first. */
export function terminalProjects(ctx: Context): { id: string; name: string }[] {
  const projects = ctx.get("projects")?.list() ?? [];
  return projects
    .filter((p) => !p.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PROJECTS)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** null asks for the project the window showed last. False when no window opened: the command failed or had nothing to open. */
export async function openTerminal(ctx: Context, projectId: string | null): Promise<boolean> {
  const contributions = ctx.get("contributions");
  if (!contributions) return false;
  try {
    const result = await contributions.run(TERMINAL_COMMAND, projectId ? { projectId } : {});
    return !result.toast;
  } catch (e) {
    ctx.logger("terminal-entries").warn(`terminal window did not open: ${errorMessage(e)}`);
    return false;
  }
}

/** One "Terminal window · Project" row per project; none where there is no Terminal window. */
export function terminalMenuItems(ctx: Context, label: (name: string) => string): MenuItemConstructorOptions[] {
  if (!hasTerminalWindow(ctx)) return [];
  return terminalProjects(ctx).map((p) => ({ label: label(p.name), click: () => void openTerminal(ctx, p.id) }));
}
