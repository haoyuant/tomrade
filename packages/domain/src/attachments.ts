/**
 * How a ticket body points at a file of the project's Files store: by id, so a
 * rename or a move in Files never breaks the link and never rewrites the body.
 */
export const FILE_LINK = "tomrade-file://";

const LINKED = /tomrade-file:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Each file id the text links to, once, in order of first mention. */
export function linkedFileIds(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(LINKED)].map((m) => m[1]!.toLowerCase()))];
}

/** A linked file as an agent can use it: where it is now and what it is. */
export interface FileDescription {
  fileId: string;
  /** Relative to the Files store root. */
  path: string;
  name: string;
  mime: string;
  size: number;
  /** On this machine, for engines that read files themselves; null when the store has no folder here. */
  localPath: string | null;
}
