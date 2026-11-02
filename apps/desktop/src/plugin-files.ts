import { protocol } from "electron";
import fs from "node:fs";
import { Readable } from "node:stream";
import type { Context } from "cordis";
import { LAYOUT_SHELL_FILE, PLUGIN_FILES_SCHEME, parsePluginFileUrl } from "@tomradex/contributions";
import { mimeOf } from "@tomradex/files";

// The window imports a native layout's module from another origin, so every answer allows it.
const CORS = { "access-control-allow-origin": "*" };

interface LayoutFiles {
  layoutRoot(pluginId: string): string | null;
  layoutFile(pluginId: string, file: string): string | null;
}

/** Before the app is ready: the scheme behaves like https — an origin per publisher, fetch, module imports, storage. */
export function registerPluginFilesScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_FILES_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

/**
 * The file on disk a `tomrade-plugin://` URL names, or null. The contributions
 * service answers only for a layout plugin's own package; the frame's page
 * (`__tomrade__/…`) is the app's own file, served under the plugin's origin so
 * the frame is that origin and nothing of the window's.
 */
export function pluginFileFor(ctx: Pick<Context, "get">, url: string, shellFile?: string): string | null {
  const parsed = parsePluginFileUrl(url);
  if (!parsed) return null;
  const contributions = ctx.get("contributions") as LayoutFiles | undefined;
  if (!contributions?.layoutRoot(parsed.pluginId)) return null;
  if (parsed.file.startsWith("__tomrade__/")) return shellFile && parsed.file === LAYOUT_SHELL_FILE ? shellFile : null;
  return contributions.layoutFile(parsed.pluginId, parsed.file);
}

/** Serves layout plugins' package files and the frame's page to the renderer; nothing else on disk is reachable through the scheme. */
export function servePluginFiles(ctx: Pick<Context, "get">, shellFile: string): void {
  protocol.handle(PLUGIN_FILES_SCHEME, (request) => {
    const file = pluginFileFor(ctx, request.url, shellFile);
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      const unbuilt = file === shellFile;
      return new Response(unbuilt ? "The layout frame is not built: pnpm --filter @tomradex/ui build:shell" : "Not found", { status: unbuilt ? 503 : 404, headers: CORS });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...CORS, "content-type": mimeOf(file) } });
  });
}
