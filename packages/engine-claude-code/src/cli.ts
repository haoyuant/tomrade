/** Claude Code cannot resume a session that is not under the current CLAUDE_CONFIG_DIR (moved, cleared, another folder). */
export const lostConversation = (text: string | undefined): boolean => /no conversation found with session id/i.test(text ?? "");

/** `claude auth status` prints JSON with `loggedIn`; a first-party account that is not logged in cannot run. */
export function claudeSignedIn(output: string): boolean | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const status = JSON.parse(output.slice(start, end + 1)) as { loggedIn?: unknown; apiProvider?: unknown };
    if (status.loggedIn !== false) return true;
    return status.apiProvider === undefined || status.apiProvider === "firstParty" ? false : null;
  } catch {
    return null;
  }
}
