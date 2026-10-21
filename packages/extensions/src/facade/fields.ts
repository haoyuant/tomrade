import type { FieldsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const fieldsApi = ({ host }: Facade): FieldsApi => {
  const fields = () => host.svc("fields");
  return {
    list: (projectId) => host.call(() => fields().list(projectId)),
    get: (projectId, id) => host.call(() => fields().get(projectId, id)),
    create: (input) => host.call(() => fields().create(input)),
    update: (projectId, id, patch) => host.call(() => fields().update(projectId, id, patch)),
    remove: (projectId, id) => host.call(() => fields().remove(projectId, id)),
    addOption: (projectId, fieldId, input) => host.call(() => fields().addOption(projectId, fieldId, input))
  };
};
