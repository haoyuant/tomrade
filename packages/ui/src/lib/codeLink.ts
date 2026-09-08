import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomrade/code-link";
import type { StartMode } from "@tomrade/code-link";
import { invoke } from "./api";
import { invalidateWorkspace } from "./queries";

export const codeLinkKeys = {
  links: (projectId: string, itemId?: string) => ["codeLink", projectId, "links", itemId ?? ""] as const,
  sessions: (projectId: string, itemId?: string) => ["codeLink", projectId, "sessions", itemId ?? ""] as const,
  repos: (projectId: string) => ["codeLink", projectId, "repos"] as const,
  proposals: (projectId: string, itemId?: string) => ["codeLink", projectId, "proposals", itemId ?? ""] as const,
  unlinked: (projectId: string) => ["codeLink", projectId, "unlinked"] as const,
  worktree: (projectId: string, itemId: string) => ["codeLink", projectId, "worktree", itemId] as const
};

export const useCodeLinks = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.links(projectId, itemId), queryFn: () => invoke("codeLink.links", projectId, itemId) });

export const useCodeSessions = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.sessions(projectId, itemId), queryFn: () => invoke("codeLink.sessions", projectId, itemId) });

/** Readiness and policy per repository, as the last scan on any machine left them. */
export const useRepoStates = (projectId: string) => useQuery({ queryKey: codeLinkKeys.repos(projectId), queryFn: () => invoke("codeLink.repos", projectId) });

export const useProposals = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.proposals(projectId, itemId), queryFn: () => invoke("codeLink.proposals", projectId, itemId) });

export const useUnlinkedBranches = (projectId: string) => useQuery({ queryKey: codeLinkKeys.unlinked(projectId), queryFn: () => invoke("codeLink.unlinked", projectId) });

/** Start or continue a ticket with a local coding agent. The result carries either a gate to clear or the thread to show. */
export function useStartTicket(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; mode: StartMode; engine?: string }) => invoke("codeLink.start", projectId, args.itemId, { mode: args.mode, engine: args.engine }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["codeLink", projectId] });
      void qc.invalidateQueries({ queryKey: ["agent", "threads", projectId] });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export function useResolveProposal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { proposalId: string; accept: boolean }) => invoke("codeLink.resolve", projectId, args.proposalId, args.accept),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["codeLink", projectId] });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export function useRescan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("codeLink.rescan", projectId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["codeLink", projectId] });
      invalidateWorkspace(qc, projectId);
    }
  });
}
