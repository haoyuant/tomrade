/**
 * How far a session may go without asking anyone, from least to most: `read` changes nothing, `ask` asks before
 * each change, `edits` edits files and asks before commands, `full` runs anything.
 */
export const CEILINGS = ["read", "ask", "edits", "full"] as const;
export type Ceiling = (typeof CEILINGS)[number];

/**
 * Each engine names its permission modes its own way. A mode this table does not know counts as `full`:
 * a mode nobody can vouch for is allowed only where everything is.
 */
const MODE_LEVEL: Record<string, Ceiling> = {
  plan: "read", "read-only": "read",
  default: "ask", local: "ask",
  acceptEdits: "edits", workspace: "edits",
  auto: "full", bypassPermissions: "full", "full-access": "full"
};
export const levelOf = (mode: string): Ceiling => MODE_LEVEL[mode] ?? "full";
export const rankOf = (level: Ceiling): number => CEILINGS.indexOf(level);

/** The most one of an engine's modes may do within a ceiling: the highest of them within it, or null when none is. */
export function modeWithin(ceiling: Ceiling, modes: readonly string[]): string | null {
  const allowed = modes.filter((mode) => rankOf(levelOf(mode)) <= rankOf(ceiling));
  return allowed.sort((a, b) => rankOf(levelOf(b)) - rankOf(levelOf(a)))[0] ?? null;
}
