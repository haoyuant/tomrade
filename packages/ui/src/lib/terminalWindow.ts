import { useMemo } from "react";
import { invoke } from "./api";
import { useCommands } from "./queries";
import { useErrorToast, useToast } from "./toast";

/** The Terminal window's own command, registered by the plugin that draws it. */
const TERMINAL_COMMAND = "code-sessions.open";

/**
 * Opens the project's Terminal window, or brings it forward when it is open; null where this app has none.
 * It runs the command directly: opening a window changes nothing the workspace shows, so nothing is asked again.
 */
export function useOpenTerminalWindow(projectId: string): (() => void) | null {
  const commands = useCommands();
  const toast = useToast();
  const reportError = useErrorToast();
  const has = !!commands.data?.some((c) => c.id === TERMINAL_COMMAND);
  return useMemo(
    () => (has ? () => void invoke("contributions.run", TERMINAL_COMMAND, { projectId }).then((result) => result.toast && toast({ body: result.toast }), reportError) : null),
    [has, projectId, toast, reportError]
  );
}
