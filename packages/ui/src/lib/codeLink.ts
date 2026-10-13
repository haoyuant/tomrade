import type { MessageKey } from "~/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/code-link";
import type { StartOptions } from "@tomradex/code-link";
import { invoke } from "./api";
import { invalidateWorkspace } from "./queries";

export const codeLinkKeys = {
  links: (projectId: string, itemId?: string) => ["codeLink", projectId, "links", itemId ?? ""] as const,
  sessions: (projectId: string, itemId?: string) => ["codeLink", projectId, "sessions", itemId ?? ""] as const,
  repos: (projectId: string) => ["codeLink", projectId, "repos"] as const,
  remoteIdentity: (remote: string) => ["codeLink", "remoteIdentity", remote] as const,
  proposals: (projectId: string, itemId?: string) => ["codeLink", projectId, "proposals", itemId ?? ""] as const,
  unlinked: (projectId: string) => ["codeLink", projectId, "unlinked"] as const,
  worktree: (projectId: string, itemId: string) => ["codeLink", projectId, "worktree", itemId] as const,
  startDefaults: ["codeLink", "startDefaults"] as const
};

/** How the Start dialog was left on this machine; null before anything was started here. */
export const useStartDefaults = () =>
  useQuery({ queryKey: codeLinkKeys.startDefaults, queryFn: () => invoke("codeLink.startDefaults") });

export const useCodeLinks = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.links(projectId, itemId), queryFn: () => invoke("codeLink.links", projectId, itemId) });

export const useCodeDeliveries = (projectId: string, itemId: string) =>
  useQuery({ queryKey: ["codeLink", projectId, "deliveries", itemId], queryFn: () => invoke("codeLink.deliveries", projectId, itemId) });

export const useCodeSessions = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.sessions(projectId, itemId), queryFn: () => invoke("codeLink.sessions", projectId, itemId) });

/** Readiness and policy per repository, as the last scan on any machine left them. */
export const useRepoStates = (projectId: string) => useQuery({ queryKey: codeLinkKeys.repos(projectId), queryFn: () => invoke("codeLink.repos", projectId) });

/** Live credential identity for a checkout. The server returns only the parsed login. */
export const useRemoteIdentity = (remote: string, enabled: boolean) =>
  useQuery({ queryKey: codeLinkKeys.remoteIdentity(remote), queryFn: () => invoke("codeLink.remoteIdentity", remote), enabled });

export const useGithubCredentialAccount = (projectId: string, repoId: string, enabled: boolean) =>
  useQuery({ queryKey: ["codeLink", projectId, "githubCredentialAccount", repoId], queryFn: () => invoke("codeLink.githubCredentialAccount", projectId, repoId), enabled });

export function useGithubCredential(projectId: string, remote: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => invoke("codeLink.useGithubCredential", projectId, repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["codeLink", projectId] });
      void qc.invalidateQueries({ queryKey: codeLinkKeys.remoteIdentity(remote) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export const useProposals = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: codeLinkKeys.proposals(projectId, itemId), queryFn: () => invoke("codeLink.proposals", projectId, itemId) });

export const useUnlinkedBranches = (projectId: string) => useQuery({ queryKey: codeLinkKeys.unlinked(projectId), queryFn: () => invoke("codeLink.unlinked", projectId) });

/** Start or continue a ticket with a local agent, coding or General. The result carries either a gate to clear or the thread to show. */
export function useStartTicket(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...opts }: StartOptions & { itemId: string }) => invoke("codeLink.start", projectId, itemId, opts),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["codeLink", projectId] });
      void qc.invalidateQueries({ queryKey: ["agent", "threads", projectId] });
      // The start remembered how it ran on this machine; the next dialog opens the same way.
      void qc.invalidateQueries({ queryKey: codeLinkKeys.startDefaults });
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

/** A branch that names no ticket becomes one, linked from the start. */
export function useAdoptBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { repoId: string; branch: string }) => invoke("codeLink.adoptBranch", projectId, args.repoId, args.branch),
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

/**
 * The permission modes the bundled engines offer, named in the person's language;
 * an engine's own label stands for any mode not listed here.
 */
const PERMISSION_LABELS: Record<string, MessageKey> = {
  auto: "codeLink.perm_auto",
  bypassPermissions: "codeLink.perm_full",
  "full-access": "codeLink.perm_full",
  acceptEdits: "codeLink.perm_acceptEdits",
  default: "codeLink.perm_ask",
  ask: "codeLink.perm_ask",
  plan: "codeLink.perm_plan",
  local: "codeLink.perm_local",
  workspace: "codeLink.perm_workspace",
  "read-only": "codeLink.perm_readOnly"
};

export const permissionLabel = (t: (key: MessageKey) => string, choice: { value: string; label?: string }): string =>
  PERMISSION_LABELS[choice.value] ? t(PERMISSION_LABELS[choice.value]!) : (choice.label ?? choice.value);

const PERMISSION_HINTS: Record<string, MessageKey> = {
  auto: "codeLink.permHint_auto",
  bypassPermissions: "codeLink.permHint_full",
  "full-access": "codeLink.permHint_full",
  acceptEdits: "codeLink.permHint_acceptEdits",
  default: "codeLink.permHint_ask",
  ask: "codeLink.permHint_ask",
  plan: "codeLink.permHint_plan",
  local: "codeLink.permHint_local",
  workspace: "codeLink.permHint_workspace",
  "read-only": "codeLink.permHint_readOnly"
};

/** What a permission mode lets the agent do, in a sentence; null for a mode an engine brought along that is not listed. */
export const permissionHint = (t: (key: MessageKey) => string, value: string | undefined): string | null =>
  value && PERMISSION_HINTS[value] ? t(PERMISSION_HINTS[value]!) : null;

/** No approval and no sandbox: worth a warning wherever it is chosen. */
export const isFullAccess = (value: string | undefined): boolean => value === "full-access" || value === "bypassPermissions";

// A start that stopped somewhere without a dialog (a section's Continue, the palette) asks the ticket's own Start button to open.
const startRequests = new Map<string, Set<(mode: "run" | "terminal") => void>>();

export function onStartRequest(itemId: string, listener: (mode: "run" | "terminal") => void): () => void {
  const set = startRequests.get(itemId) ?? new Set();
  set.add(listener);
  startRequests.set(itemId, set);
  return () => set.delete(listener);
}

/** Whether a Start button for this ticket is on screen to take it. */
export function requestStart(itemId: string, mode: "run" | "terminal"): boolean {
  const listeners = [...(startRequests.get(itemId) ?? [])];
  listeners.at(-1)?.(mode);
  return listeners.length > 0;
}
