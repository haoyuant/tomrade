/** Whether text entered for a destructive confirmation names the target. */
export function confirmationMatches(typed: string, expected: string): boolean {
  return typed.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase();
}
