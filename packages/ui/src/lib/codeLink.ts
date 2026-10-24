import type { MessageKey } from "~/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/code-link";
import type { ConnectAgent, ConnectMode, MergeCheckView, RepoPolicyPatch, StartBatchRequest, StartOptions } from "@tomradex/code-link";
import { invoke } from "./api";
import { invalidateWorkspace, keys } from "./queries";

export const useHerdrStatus = (enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.herdrStatus, queryFn: () => invoke("codeLink.herdrStatus"), enabled, refetchInterval: 5000 });

/** Sessions started on this project open in Tomrade's own Terminal window: herdr is the terminal here and the window is on. */
export const useTerminalWindow = (projectId: string) =>
  useQuery({ queryKey: keys.codeLink.terminalWindow(projectId), queryFn: () => invoke("codeLink.terminalWindow", projectId) });

/**
 * Where Start runs before the person picks: how this delivery's last session ran; else, for coding work whose agent
 * can run in a terminal, Tomrade's own terminal when the Terminal window shows it; else how Start was last left here.
 */
export function defaultStartMode(input: { latest: "headless" | "terminal" | null; remembered: StartOptions["mode"] | null; terminalWindow: boolean; coding: boolean; agentInTerminal: boolean }): StartOptions["mode"] {
  if (input.latest) return input.latest === "terminal" ? "terminal" : "run";
  if (input.terminalWindow && input.coding && input.agentInTerminal) return "terminal";
  return input.remembered === "terminal" ? "terminal" : "run";
}

/** How the Start dialog was left on this machine; null before anything was started here. */
export const useStartDefaults = () =>
  useQuery({ queryKey: keys.codeLink.startDefaults, queryFn: () => invoke("codeLink.startDefaults") });

export const useCodeDeliveries = (projectId: string, itemId: string) =>
  useQuery({ queryKey: keys.codeLink.deliveries(projectId, itemId), queryFn: () => invoke("codeLink.deliveries", projectId, itemId) });

export const useCodeSessions = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: keys.codeLink.sessions(projectId, itemId), queryFn: () => invoke("codeLink.sessions", projectId, itemId) });

/** Readiness and policy per repository, as the last scan on any machine left them. */
export const useRepoStates = (projectId: string) => useQuery({ queryKey: keys.codeLink.repos(projectId), queryFn: () => invoke("codeLink.repos", projectId) });

/** Live credential identity for a checkout. The server returns only the parsed login. */
export const useRemoteIdentity = (remote: string, enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.remoteIdentity(remote), queryFn: () => invoke("codeLink.remoteIdentity", remote), enabled });

export const useGithubCredentialAccount = (projectId: string, repoId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.githubCredentialAccount(projectId, repoId), queryFn: () => invoke("codeLink.githubCredentialAccount", projectId, repoId), enabled });

export function useGithubCredential(projectId: string, remote: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => invoke("codeLink.useGithubCredential", projectId, repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      void qc.invalidateQueries({ queryKey: keys.codeLink.remoteIdentity(remote) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

/** Check origin again from this checkout; a credential helper that cannot run is repaired first. */
export function useRecheckRemote(projectId: string, remote: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => invoke("codeLink.recheckRemote", projectId, repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      void qc.invalidateQueries({ queryKey: keys.codeLink.remoteIdentity(remote) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export const useProposals = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: keys.codeLink.proposals(projectId, itemId), queryFn: () => invoke("codeLink.proposals", projectId, itemId) });

export const useUnlinkedBranches = (projectId: string) => useQuery({ queryKey: keys.codeLink.unlinked(projectId), queryFn: () => invoke("codeLink.unlinked", projectId) });

/** Start or continue a ticket with a local agent, coding or General. The result carries either a gate to clear or the thread to show. */
export function useSetRepoPolicy(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, patch }: { repoId: string; patch: RepoPolicyPatch }) => invoke("codeLink.setRepoPolicy", projectId, repoId, patch),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.codeLink.repos(projectId) })
  });
}

/** Whether each installed coding agent's own settings let it run gh pr merge in this repository. */
export const useMergeChecks = (projectId: string, repoId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.mergeChecks(projectId, repoId), queryFn: () => invoke("codeLink.mergeChecks", projectId, repoId), enabled });

export type ReadMergeCheck = MergeCheckView & { check: NonNullable<MergeCheckView["check"]> };

/** Agents whose settings were read get a row each; the rest are named together in one. */
export function splitMergeChecks(views: MergeCheckView[]): { known: ReadMergeCheck[]; unknown: string[] } {
  return { known: views.filter((view): view is ReadMergeCheck => view.check !== null), unknown: views.filter((view) => !view.check).map((view) => view.title) };
}

export function useAllowMerge(projectId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (engineId: string) => invoke("codeLink.allowMerge", projectId, repoId, engineId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.codeLink.mergeChecks(projectId, repoId) })
  });
}

export function useStartTicket(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...opts }: StartOptions & { itemId: string }) => invoke("codeLink.start", projectId, itemId, opts),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      void qc.invalidateQueries({ queryKey: keys.agent.threads(projectId) });
      // The start remembered how it ran on this machine; the next dialog opens the same way.
      void qc.invalidateQueries({ queryKey: keys.codeLink.startDefaults });
      invalidateWorkspace(qc, projectId);
    }
  });
}

/** Several tickets at once from a conversation's card, with the configuration picked there. */
export function useStartTickets(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: StartBatchRequest) => invoke("codeLink.startTickets", projectId, request),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      void qc.invalidateQueries({ queryKey: keys.agent.threads(projectId) });
      void qc.invalidateQueries({ queryKey: keys.codeLink.startDefaults });
      invalidateWorkspace(qc, projectId);
    }
  });
}

/** The person's word on a delivered ticket: its pull request through gh, or its branch here without a remote. */
export function useMergeTicket(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => invoke("codeLink.merge", projectId, itemId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export function useResolveProposal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { proposalId: string; accept: boolean }) => invoke("codeLink.resolve", projectId, args.proposalId, args.accept),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
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
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      invalidateWorkspace(qc, projectId);
    }
  });
}

export function useRescan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("codeLink.rescan", projectId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
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
// null only opens the dialog, for the person to choose; a mode also starts at once. An offer may name what to do first.
type StartListener = (mode: "run" | "terminal" | null, task?: string) => void;
const startRequests = new Map<string, Set<StartListener>>();
// An offer taken while its ticket is still opening waits for the first Start button that mounts.
const waitingOffers = new Map<string, { at: number; task?: string }>();

export function onStartRequest(itemId: string, listener: StartListener): () => void {
  const set = startRequests.get(itemId) ?? new Set();
  set.add(listener);
  startRequests.set(itemId, set);
  const offer = waitingOffers.get(itemId);
  waitingOffers.delete(itemId);
  if (offer && Date.now() - offer.at < 10_000) listener(null, offer.task);
  return () => set.delete(listener);
}

/** Whether a Start button for this ticket is on screen to take it. */
export function requestStart(itemId: string, mode: "run" | "terminal"): boolean {
  const listeners = [...(startRequests.get(itemId) ?? [])];
  listeners.at(-1)?.(mode);
  return listeners.length > 0;
}

/** Opens the ticket's Start dialog — now, or once the ticket being opened shows its Start button. */
export function offerStart(itemId: string, task?: string): void {
  const listeners = [...(startRequests.get(itemId) ?? [])];
  if (listeners.length) listeners.at(-1)!(null, task);
  else waitingOffers.set(itemId, { at: Date.now(), ...(task ? { task } : {}) });
}

export const useRepositoryConnection = (projectId: string, repoId: string) =>
  useQuery({ queryKey: keys.codeLink.connection(projectId, repoId), queryFn: () => invoke("codeLink.connection", projectId, repoId), refetchInterval: 10_000 });

/** For the team through a branch and pull request, or for this machine only: files in the checkout that git ignores. */
export function useConnectRepository(projectId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: ConnectMode = "team") => invoke("codeLink.connect", projectId, repoId, mode),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.codeLink.connection(projectId, repoId) })
  });
}

/** Which coding agents this repository is connected for; the connection is judged by them alone. */
export function useChooseConnectAgents(projectId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectAgents: ConnectAgent[]) => invoke("codeLink.setRepoPolicy", projectId, repoId, { connectAgents }),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.codeLink.connection(projectId, repoId) })
  });
}
