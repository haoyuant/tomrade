import type { Author, Item, Provenance } from "./types.js";

export const isAi = (by: Author | string): boolean => by.startsWith("ai:");
const isSync = (by: Author | string): boolean => by.startsWith("sync:");

/** Derived, never stored: a locked item reads as locked whoever wrote it last. */
export function provenanceOf(item: Pick<Item, "humanLocked" | "updatedBy">): Provenance {
  if (item.humanLocked) return "locked";
  return isAi(item.updatedBy) ? "ai" : isSync(item.updatedBy) ? "sync" : "human";
}

/** 'Tomrade Desktop' -> 'TOM'. Falls back to a generic prefix for nameless input. */
export function keyPrefixFor(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.slice(0, 3) || "ISS";
}
