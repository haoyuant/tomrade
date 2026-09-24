/**
 * Module resolution for code that lives outside the app. An extension imports
 * `cordis`, `@tomrade/plugin-sdk` and `zod` but ships none of them: it must
 * get the host's own copies, or it would build its own world beside ours.
 * Runs on Node's loader thread.
 */
interface HookData {
  map: Record<string, string>;
  /** file: URL prefixes of the app itself, whose imports resolve as usual. */
  inside: string[];
}

let data: HookData = { map: {}, inside: [] };

export async function initialize(given: HookData): Promise<void> {
  data = given;
}

type Next = (specifier: string, context: { parentURL?: string }) => Promise<{ url: string }>;

export async function resolve(specifier: string, context: { parentURL?: string }, next: Next) {
  const parent = context.parentURL;
  const url = data.map[specifier];
  if (url && parent?.startsWith("file:") && !data.inside.some((prefix) => parent.startsWith(prefix))) return { url, shortCircuit: true };
  return next(specifier, context);
}
