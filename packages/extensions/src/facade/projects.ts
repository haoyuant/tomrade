import type { ProjectsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const projectsApi = ({ host }: Facade): ProjectsApi => {
  const projects = () => host.svc("projects");
  return {
    list: () => host.call(() => projects().list()),
    get: (id) => host.call(() => projects().get(id))
  };
};
