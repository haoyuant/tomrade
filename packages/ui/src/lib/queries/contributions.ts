import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandScope } from "@tomradex/contributions";
import { invoke } from "../api";
import { invalidateWorkspace } from "./invalidate";
import { keys } from "./keys";

export const useCommands = () => useQuery({ queryKey: keys.commands, queryFn: () => invoke("contributions.commands") });
export const useBadges = (projectId: string) => useQuery({ queryKey: keys.badges(projectId), queryFn: () => invoke("contributions.badges", projectId) });
export const useStatusItems = (projectId?: string) =>
  useQuery({ queryKey: keys.statusItems(projectId), queryFn: () => invoke("contributions.statusItems", { projectId }) });
export const useSections = (projectId: string, itemId: string | undefined) =>
  useQuery({ queryKey: keys.sections(projectId, itemId ?? ""), queryFn: () => invoke("contributions.sections", projectId, itemId!), enabled: !!itemId });
export const useGraphs = () => useQuery({ queryKey: keys.graphs, queryFn: () => invoke("contributions.graphs") });
export const useGraphEdges = (projectId: string, graphId: string | null) =>
  useQuery({ queryKey: keys.graphEdges(projectId, graphId ?? ""), queryFn: () => invoke("contributions.graph", graphId!, { projectId }), enabled: !!graphId });
export const useAssistantAccessories = () =>
  useQuery({ queryKey: keys.assistantAccessories, queryFn: () => invoke("contributions.assistantAccessories"), staleTime: Infinity });

export function useRunCommand(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; scope: CommandScope }) => invoke("contributions.run", args.id, args.scope),
    onSettled: () => projectId && invalidateWorkspace(qc, projectId)
  });
}
