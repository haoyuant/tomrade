import path from "node:path";
import type { ContributionsApi } from "@tomradex/plugin-sdk";
import { packageFile } from "./package-file.js";
import { COMMAND_MS, RENDER_MS, type Facade } from "./shared.js";

export const contributionsApi = ({ host }: Facade): ContributionsApi => {
  const c = () => host.svc("contributions");
  return {
    command: (def) =>
      host.call(() => {
        host.own(def.id, "command");
        const run = host.back(def.run, `command ${def.id}`, { human: true, ms: COMMAND_MS });
        return host.disposerOf(c().command({ id: def.id, title: host.say(def.title), group: host.say(def.group), shortcut: def.shortcut, run: (scope) => run(scope).then((r) => r ?? undefined) }));
      }),
    badge: (def) =>
      host.call(() => {
        host.own(def.id, "badge");
        return host.disposerOf(c().badge({ id: def.id, compute: host.back(def.compute, `badge ${def.id}`, { ms: RENDER_MS }) }));
      }),
    statusItem: (def) =>
      host.call(() => {
        host.own(def.id, "status item");
        if (def.command) host.own(def.command, "status item command");
        const until = def.until ? host.back(def.until, `status item ${def.id} until`, { ms: RENDER_MS }) : undefined;
        const menu = def.menu ? host.back(def.menu, `status item ${def.id} menu`, { ms: RENDER_MS }) : undefined;
        return host.disposerOf(c().statusItem({
          id: def.id, text: host.back(def.text, `status item ${def.id}`, { ms: RENDER_MS }), title: host.say(def.title), icon: def.icon, align: def.align, command: def.command,
          ...(until ? { until } : {}),
          ...(menu ? { menu: async (scope: { projectId?: string }) => {
            const entries = await menu(scope);
            for (const entry of entries ?? []) host.own(entry.command, "status menu command");
            return entries;
          } } : {})
        }));
      }),
    refresh: () =>
      host.call(() => {
        c().changed();
      }),
    section: (def) =>
      host.call(() => {
        host.own(def.id, "section");
        return host.disposerOf(c().section({ id: def.id, title: host.say(def.title), render: host.back(def.render, `section ${def.id}`, { ms: RENDER_MS }) }));
      }),
    graph: (def) =>
      host.call(() => {
        host.own(def.id, "graph");
        return host.disposerOf(c().graph({ id: def.id, title: def.title, icon: def.icon, edits: def.edits, compute: host.back(def.compute, `graph ${def.id}`, { ms: RENDER_MS }) }));
      }),
    sidebarModule: (def) =>
      host.call(() => {
        host.own(def.id, "sidebar module");
        const rows = def.rows ? host.back(def.rows, `sidebar module ${def.id}`, { ms: RENDER_MS }) : undefined;
        return host.disposerOf(c().sidebarModule({ id: def.id, title: host.say(def.title), icon: def.icon, command: def.command, ...(rows ? { rows } : {}) }));
      }),
    layout: (def) =>
      host.call(() => {
        host.own(def.id, "layout");
        const render = def.render ?? "sandbox";
        if (render === "native" && host.identity.origin === "extension" && !host.identity.renderer) throw new Error(`${host.identity.id} draws layout "${def.id}" inside Tomrade's window but its manifest does not grant permissions.renderer`);
        const file = packageFile(host, def.module, "layout module");
        const root = host.identity.root!;
        return host.disposerOf(c().layout({ id: def.id, title: host.say(def.title), icon: def.icon, module: path.relative(root, file).split(path.sep).join("/"), render, plugin: { id: host.identity.id, root } }));
      })
  };
};
