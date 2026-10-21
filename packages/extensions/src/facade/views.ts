import type { ViewsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const viewsApi = ({ host }: Facade): ViewsApi => {
  const views = () => host.svc("views");
  return {
    list: (projectId) => host.call(() => views().listForProject(projectId)),
    get: (projectId, id) => host.call(() => views().get(projectId, id))
  };
};
