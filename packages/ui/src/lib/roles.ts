import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Role, RoleInput } from "@tomradex/roles";
import { invoke } from "./api";
import { keys } from "./queries";

/** The limits a role may set, least first: the scale every permission mode is measured on. */
export const ROLE_LIMITS = ["read", "ask", "edits", "full"] as const;

/** The project's roles: the two built-in ones first, then its own. */
export const useRoles = (projectId: string, enabled = true) => useQuery({ queryKey: keys.roles.list(projectId), queryFn: () => invoke("roles.list", projectId), enabled });

/** The permission mode a role's run starts in with an engine; null when the role leaves that to the engine or the person. */
export const useRoleMode = (projectId: string, role: Pick<Role, "id" | "permission" | "updatedAt"> | null | undefined, engine: string, enabled = true) =>
  useQuery({
    queryKey: [...keys.roles.list(projectId), "mode", role?.id ?? "", role?.updatedAt ?? 0, engine],
    queryFn: () => invoke("roles.mode", projectId, role!.id, engine),
    enabled: enabled && !!role?.permission && !!engine && engine !== "other"
  });

export const useSaveRole = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: RoleInput) => invoke("roles.save", projectId, input), onSettled: () => void qc.invalidateQueries({ queryKey: keys.roles.list(projectId) }) });
};

export const useRemoveRole = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => invoke("roles.remove", projectId, id), onSettled: () => void qc.invalidateQueries({ queryKey: keys.roles.list(projectId) }) });
};
