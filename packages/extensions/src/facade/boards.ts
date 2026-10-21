import type { BoardsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const boardsApi = ({ host }: Facade): BoardsApi => {
  const boards = () => host.svc("boards");
  return {
    list: (projectId) => host.call(() => boards().list(projectId)),
    get: (projectId, id) => host.call(() => boards().get(projectId, id)),
    defaultFor: (projectId) => host.call(() => boards().defaultFor(projectId))
  };
};
