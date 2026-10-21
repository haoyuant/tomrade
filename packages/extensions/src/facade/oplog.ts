import type { OplogApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const oplogApi = ({ host }: Facade): OplogApi => {
  const oplog = () => host.svc("oplog");
  return {
    recent: (projectId, limit) => host.call(() => oplog().recent(projectId, limit)),
    history: (projectId, entity, id, limit) => host.call(() => oplog().historyFor(projectId, entity, id, limit))
  };
};
