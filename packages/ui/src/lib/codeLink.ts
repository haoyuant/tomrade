import type { MessageKey } from "~/lib/i18n";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/code-link";
import type { ConnectAgent, ConnectMode, MergeCheckView, RepoPolicyPatch, StartBatchRequest, StartOptions, WorktreeGroup, WorktreeHold, WorktreeRemoval, WorktreeView } from "@tomradex/code-link";
import { invoke } from "./api";
import { invalidateWorkspace, keys } from "./queries";

export const useHerdrStatus = (enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.herdrStatus, queryFn: () => invoke("codeLink.herdrStatus"), enabled, refetchInterval: 5000 });

/** gh on this machine: a recommendation for pull requests, so it is asked once a minute at most. */
export const useGhStatus = (enabled: boolean) => useQuery({ queryKey: keys.codeLink.gh, queryFn: () => invoke("codeLink.gh"), enabled, staleTime: 60_000 });

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

export type StartStep = "worktree" | "branch" | "mcp" | "agent" | "terminal";
export interface StartProgress {
  steps: StartStep[];
  /** Index into steps of the one the wait is shown on. */
  current: number;
  /** Past ~10 s: say a first worktree or a large repository is slow, not stuck. */
  slow: boolean;
  /** Past ~60 s: say where to look. */
  stalled: boolean;
}

const STEP_MS = 2500;

/**
 * What a pending Start is shown doing. codeLink.start is one IPC call that reports nothing until it returns,
 * so the step is a guess from the time elapsed, in the order the backend works; the last one holds until it answers.
 */
export function startProgress(elapsedMs: number, input: { mode: StartOptions["mode"]; general: boolean }): StartProgress {
  const launch: StartStep = input.mode === "terminal" ? "terminal" : "agent";
  // General work runs in a plain folder: no worktree, no branch.
  const steps: StartStep[] = input.general ? ["mcp", launch] : ["worktree", "branch", "mcp", launch];
  const current = Math.min(Math.max(0, Math.floor(elapsedMs / STEP_MS)), steps.length - 1);
  return { steps, current, slow: elapsedMs >= 10_000, stalled: elapsedMs >= 60_000 };
}

/**
 * Where a start card's pending start is, ticket by ticket. The backend starts them one after another and posts
 * each outcome as it comes, so the first without a new outcome is the one starting and the rest wait their turn.
 * `hadOutcome` is what had one when the start was asked: a ticket started again waits until the whole start answers.
 */
export function startBatchWaits(itemIds: string[], outcomes: { itemId: string }[] | undefined, hadOutcome: ReadonlySet<string>): Map<string, "starting" | "queued"> {
  const waiting = itemIds.filter((id, at) => itemIds.indexOf(id) === at && (hadOutcome.has(id) || !outcomes?.some((o) => o.itemId === id)));
  return new Map(waiting.map((id, at) => [id, at === 0 ? "starting" : "queued"]));
}

/** How the Start dialog was left on this machine; null before anything was started here. */
export const useStartDefaults = () =>
  useQuery({ queryKey: keys.codeLink.startDefaults, queryFn: () => invoke("codeLink.startDefaults") });

export const useCodeDeliveries = (projectId: string, itemId: string) =>
  useQuery({ queryKey: keys.codeLink.deliveries(projectId, itemId), queryFn: () => invoke("codeLink.deliveries", projectId, itemId) });

export const useCodeSessions = (projectId: string, itemId?: string) =>
  useQuery({ queryKey: keys.codeLink.sessions(projectId, itemId), queryFn: () => invoke("codeLink.sessions", projectId, itemId) });

/** Live sessions and the few that ended today: what the session bars list. Asked again once per burst of session changes, so it stays small. */
export const useRecentSessions = (projectId: string, enabled = true) =>
  useQuery({ queryKey: keys.codeLink.recentSessions(projectId), queryFn: () => invoke("codeLink.recentSessions", projectId), enabled });

/** Which Terminal window cell shows each session, by session id; empty while the window is closed. */
export const useSessionCells = (projectId: string, enabled = true) =>
  useQuery({ queryKey: keys.codeLink.cells(projectId), queryFn: () => invoke("codeLink.sessionCells", projectId), enabled });

/** The ticket's conversations by when each began, what it delivered, and two at work in one folder. */
export const useTicketTimeline = (projectId: string, itemId: string) =>
  useQuery({ queryKey: keys.codeLink.timeline(projectId, itemId), queryFn: () => invoke("codeLink.timeline", projectId, itemId) });

/** Where a conversation runs — here, or in a terminal cell as a session — and whether it can move now; asked again on every session change. */
export const useHandoff = (projectId: string, threadId: string | null) =>
  useQuery({ queryKey: keys.codeLink.handoff(projectId, threadId ?? ""), queryFn: () => invoke("codeLink.handoff", projectId, threadId!), enabled: !!threadId, staleTime: 5_000 });

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

/** The worktrees Tomrade made for the project's repositories on this machine. Each read asks git about them, so the page that lists them asks as it opens and after a removal. */
export const useWorktrees = (projectId: string) => useQuery({ queryKey: keys.codeLink.worktrees(projectId), queryFn: () => invoke("codeLink.worktrees", projectId) });

/** Every open project's worktrees by repository, and the disk the Hub keeps them on: what Settings shows of them. */
export const useWorktreeOverview = () => useQuery({ queryKey: keys.codeLink.worktreeOverview, queryFn: () => invoke("codeLink.worktreeOverview") });

/** What each takes on disk, by folder; asked only while they are shown, and a size not read yet is absent. */
export function useWorktreeSizes(trees: { projectId: string; dir: string }[], enabled: boolean): Map<string, number | null> {
  const sizes = useQueries({
    queries: trees.map(({ projectId, dir }) => ({ queryKey: keys.codeLink.worktreeSize(projectId, dir), queryFn: () => invoke("codeLink.worktreeSize", projectId, dir), enabled, staleTime: 10 * 60_000 }))
  });
  return new Map(trees.flatMap(({ dir }, at) => (sizes[at]?.data === undefined ? [] : [[dir, sizes[at]!.data!] as const])));
}

const MB = 1024 * 1024;
/** What a worktree weighs: megabytes, gigabytes from one up, kilobytes for one with no install in it. */
export const diskSize = (bytes: number): string =>
  bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : bytes >= 10 * MB ? `${Math.round(bytes / MB)} MB` : bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export const WORKTREE_HOLD_KEY: Record<WorktreeHold, MessageKey> = {
  open: "repositories.worktreeHold_open",
  busy: "repositories.worktreeHold_busy",
  dirty: "repositories.worktreeHold_dirty",
  loose: "repositories.worktreeHold_loose",
  unticketed: "repositories.worktreeHold_unticketed"
};

/** Where a worktree outside the Hub is, short enough for a row: its folder and the one that holds it. */
export const worktreePlace = (dir: string): string => dir.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");

/** Whether nothing would be lost with it, as far as git can tell: what "remove all" takes. A stray is never one. */
export const worktreeCanGo = (tree: Pick<WorktreeView, "hold" | "stray">): boolean => !tree.hold && !tree.stray;

/** Why a worktree is still there, or when it goes: one line under its name. */
export function worktreeState(tree: Pick<WorktreeView, "owner" | "hold" | "removeAt" | "stray">, now: number): { key: MessageKey; at?: number } {
  if (tree.hold === "open" && tree.owner === "conversation") return { key: "repositories.worktreeHold_openConversation" };
  if (tree.hold) return { key: WORKTREE_HOLD_KEY[tree.hold] };
  if (tree.stray) return { key: "repositories.worktreeStrayFree" };
  if (tree.removeAt === null) return { key: "repositories.worktreeFree" };
  return tree.removeAt <= now ? { key: "repositories.worktreeDueNow" } : { key: "repositories.worktreeDue", at: tree.removeAt };
}

/** What a removal that left some behind says: how many went, and why the first that stayed did. */
export function removalSummary(removals: WorktreeRemoval[]): { removed: number; kept: number; reason: string | null } {
  const kept = removals.filter((removal) => !removal.removed);
  return { removed: removals.length - kept.length, kept: kept.length, reason: kept[0]?.reason ?? null };
}

/** Where a worktree's space counts: nothing holds it, it is finished but something does, it is still in use (or the person's own, on no ticket), or git no longer knows it. */
export type WorktreeBucket = "free" | "held" | "open" | "stray";
export const worktreeBucket = (tree: Pick<WorktreeView, "hold" | "stray">): WorktreeBucket => (tree.stray ? "stray" : !tree.hold ? "free" : tree.hold === "open" || tree.hold === "unticketed" ? "open" : "held");

/**
 * The worktrees of every repository added up, with the sizes read so far: how many, what they take, how that splits
 * by whether each can go, and the repositories from the one that takes most.
 */
export function worktreeTotals(groups: WorktreeGroup[], sizes: ReadonlyMap<string, number | null>) {
  const buckets: Record<WorktreeBucket, { n: number; bytes: number }> = { free: { n: 0, bytes: 0 }, held: { n: 0, bytes: 0 }, open: { n: 0, bytes: 0 }, stray: { n: 0, bytes: 0 } };
  let count = 0;
  let measured = 0;
  let bytes = 0;
  const repos = groups
    .map((group) => {
      let taken = 0;
      for (const tree of group.trees) {
        const size = sizes.get(tree.dir);
        if (size !== undefined) measured++;
        const bucket = buckets[worktreeBucket(tree)];
        bucket.n++;
        bucket.bytes += size ?? 0;
        taken += size ?? 0;
      }
      count += group.trees.length;
      bytes += taken;
      return { projectId: group.projectId, project: group.project, repoId: group.repoId, repo: group.repo, n: group.trees.length, bytes: taken };
    })
    .sort((a, b) => b.bytes - a.bytes || b.n - a.n);
  return { count, measured, bytes, buckets, repos };
}

/** Removes worktrees on the person's word, project by project; each comes back removed, or with what held it. `strays`: the person agreed to lose what git cannot check. */
export function useRemoveWorktrees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (asks: { projectId: string; dirs: string[]; strays?: boolean }[]) => {
      const out: WorktreeRemoval[] = [];
      for (const ask of asks) out.push(...(await invoke("codeLink.removeWorktrees", ask.projectId, ask.dirs, ask.strays)));
      return out;
    },
    onSettled: (_removals, _error, asks) => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.worktreesAll });
      for (const ask of asks) void qc.invalidateQueries({ queryKey: keys.codeLink.all(ask.projectId) });
      // where an agent would run may have changed
      void qc.invalidateQueries({ queryKey: keys.agent.workdirAll });
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

/** A merge refused for a conflict: the ticket's session is sent back to bring its branch up to date, from this conversation. */
export function useResolveMerge(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; requestedBy: string }) => invoke("codeLink.resolveMerge", projectId, args.itemId, args.requestedBy),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      void qc.invalidateQueries({ queryKey: keys.agent.threads(projectId) });
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
type StartListener = (mode: "run" | "terminal" | null, task?: string, apart?: boolean) => void;
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

/** Opens the ticket's Start dialog on another session beside the one at work, in a folder of its own; false with no Start button to take it. */
export function offerApart(itemId: string): boolean {
  const listeners = [...(startRequests.get(itemId) ?? [])];
  listeners.at(-1)?.(null, undefined, true);
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
