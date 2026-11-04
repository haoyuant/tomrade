import type { SettingsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const settingsApi = ({ host, ns }: Facade): SettingsApi => {
  const settings = () => host.svc("settings");
  return {
    register: (section) =>
      host.call(() => {
        const id = section.id ?? ns;
        host.own(id, "settings section");
        settings().register({ id, title: section.title, description: section.description, schema: section.schema, defaults: section.defaults, scope: section.scope, agent: section.agent, order: 100, ...(section.words ? { words: section.words } : {}) });
      }),
    get: <T>(id?: string) => host.call(() => settings().value(id ?? ns) as T),
    set: (value, id) =>
      host.call(() => {
        const key = id ?? ns;
        host.own(key, "settings section");
        settings().set({ [key]: value } as never);
      }),
    locale: () => host.call(() => host.locale()),
    show: (id) =>
      host.call(() => {
        const key = id ?? ns;
        host.own(key, "settings section");
        settings().show(key);
      })
  };
};
