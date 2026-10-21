import type { AlertsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const alertsApi = ({ host }: Facade): AlertsApi => {
  const alerts = () => host.svc("alerts");
  return {
    sounds: () => host.call(() => alerts().sounds()),
    play: (sound, opts) => host.call(() => alerts().play(sound, opts)),
    notify: (notice) => host.call(() => alerts().notify({ title: String(notice.title), body: notice.body === undefined ? undefined : String(notice.body) }))
  };
};
