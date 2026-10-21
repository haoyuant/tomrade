import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SurfacesApi } from "@tomradex/plugin-sdk";
import type { Host } from "../host.js";
import { within } from "../scope.js";
import type { Facade } from "./shared.js";

/** What a plugin's window is called: its own title, then the plugin's, so it never passes for Tomrade's or another app's. */
export const windowTitle = (title: string, owner: string | undefined): string => (owner && title !== owner ? `${title} — ${owner}` : title);

/** Only a file inside the plugin's own package may be shown in a surface. */
const documentUrl = (host: Host, document: string): string => {
  const root = host.identity.root;
  if (!root) throw new Error(`${host.identity.id} has no package directory to open "${document}" from`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(document)) throw new Error(`surface documents must be files inside the plugin, not "${document}"`);
  const file = path.resolve(root, document);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`surface document "${document}" is outside the plugin`);
  if (!fs.existsSync(file)) throw new Error(`surface document "${document}" does not exist`);
  return pathToFileURL(file).href;
};

export const surfacesApi = ({ host, ns }: Facade): SurfacesApi => {
  const surfaces = () => host.svc("surfaces");
  return {
    open: (spec) =>
      host.call(() => {
        host.own(spec.id, "surface");
        const window = spec.kind === "window";
        if (window && host.identity.origin === "extension" && !host.identity.window) throw new Error(`${host.identity.id} opens window "${spec.id}" but its manifest does not grant permissions.window`);
        const url = documentUrl(host, spec.document);
        const onMessage = spec.onMessage ? host.listen(spec.onMessage, `surface ${spec.id}`) : undefined;
        const onClose = spec.onClose ? host.listen(spec.onClose, `surface ${spec.id} close`) : undefined;
        let closed = false;
        // A call on a closed window used to go nowhere; the plugin hears of it instead.
        const live = <T>(fn: () => T) => host.call(() => {
          if (closed) throw new Error(`surface ${spec.id} is closed`);
          return fn();
        });
        const surface = surfaces().open({
          id: spec.id,
          title: window ? windowTitle(String(spec.title), host.identity.title) : spec.title,
          url,
          width: spec.width,
          height: spec.height,
          ...(window ? { kind: "window" as const, ...(spec.minWidth ? { minWidth: spec.minWidth } : {}), ...(spec.minHeight ? { minHeight: spec.minHeight } : {}) } : {}),
          transparent: spec.transparent,
          alwaysOnTop: spec.alwaysOnTop,
          focusable: spec.focusable,
          clickThrough: spec.clickThrough,
          anchor: spec.anchor,
          initialState: spec.initialState,
          onMessage: onMessage ? (m) => within(ns, () => onMessage(m as never), true) : undefined,
          onClose: () => {
            if (closed) return;
            closed = true;
            onClose?.();
          }
        });
        return {
          id: surface.id,
          setState: (state: unknown) => live(() => surface.setState(state)),
          post: (message: unknown) => live(() => surface.post(message)),
          setPosition: (x: number, y: number) => live(() => surface.setPosition(x, y)),
          bounds: () => live(() => surface.bounds()),
          workArea: () => live(() => surface.workArea()),
          // Closing twice is harmless.
          close: () => host.call(() => (closed ? undefined : surface.close()))
        };
      })
  };
};
