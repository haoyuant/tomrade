import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {} from "@tomrade/files";
import type { ConflictChoice, SyncMode } from "@tomrade/files";
import type { FileReference } from "@tomrade/domain";
import { invoke } from "./api";
import { invalidateWorkspace } from "./queries";

/** The drag payload for moving a file or folder within the tree/table — never set for a drag out to the OS. */
export const FILES_DRAG_MIME = "application/x-tomrade-paths";

export const filesKeys = {
  all: (projectId: string) => ["files", projectId] as const,
  tree: (projectId: string) => ["files", projectId, "tree"] as const,
  status: (projectId: string) => ["files", projectId, "status"] as const,
  info: (projectId: string) => ["files", projectId, "info"] as const,
  syncPolicy: (projectId: string) => ["files", projectId, "syncPolicy"] as const,
  content: (projectId: string, path: string) => ["files", projectId, "read", path] as const,
  version: (projectId: string, fileId: string, versionId: string) => ["files", projectId, "version", fileId, versionId] as const,
  location: (projectId: string, fileId: string) => ["files", projectId, "locate", fileId] as const,
  history: (projectId: string, path: string) => ["files", projectId, "history", path] as const,
  conflicts: (projectId: string) => ["files", projectId, "conflicts"] as const,
  backends: ["files", "backends"] as const,
  connection: (backendId: string) => ["files", "connection", backendId] as const
};

/** Everything keyed by one project's files: the tree, the open file, its versions, the state. */
export const invalidateFiles = (qc: QueryClient, projectId: string): void => void qc.invalidateQueries({ queryKey: filesKeys.all(projectId) });

export const useFilesTree = (projectId: string) => useQuery({ queryKey: filesKeys.tree(projectId), queryFn: () => invoke("files.tree", projectId), retry: false });

/** Asked for on open and after an action, never polled: the main process pushes `files.changed` when anything moves. */
export const useFilesStatus = (projectId: string) => useQuery({ queryKey: filesKeys.status(projectId), queryFn: () => invoke("files.status", projectId), retry: false, staleTime: 10_000 });

export const useFilesInfo = (projectId: string) => useQuery({ queryKey: filesKeys.info(projectId), queryFn: () => invoke("files.info", projectId), retry: false });

export const useFilesSyncPolicy = (projectId: string) => useQuery({ queryKey: filesKeys.syncPolicy(projectId), queryFn: () => invoke("files.syncPolicy", projectId), retry: false, staleTime: 10_000 });

export function useSetSyncRules(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["files", projectId, "setSyncRules"],
    mutationFn: ({ paths, mode }: { paths: string[]; mode: SyncMode | "inherit" }) => invoke("files.setSyncRules", projectId, paths, mode),
    onSuccess: (policy) => {
      qc.setQueryData(filesKeys.syncPolicy(projectId), policy);
      invalidateFiles(qc, projectId);
    }
  });
}

export const useFileContent = (projectId: string, path: string | null) =>
  useQuery({ queryKey: filesKeys.content(projectId, path ?? ""), queryFn: () => invoke("files.read", projectId, path!), enabled: path !== null && path !== "", retry: false });

/** An immutable version: cached for good, since it can never change. */
export const useFileVersion = (projectId: string, ref: FileReference | null) =>
  useQuery({
    queryKey: filesKeys.version(projectId, ref?.fileId ?? "", ref?.versionId ?? ""),
    queryFn: () => invoke("files.readVersion", projectId, ref!),
    enabled: !!ref,
    retry: false,
    staleTime: Infinity
  });

export const useFileLocation = (projectId: string, fileId: string | null) =>
  useQuery({ queryKey: filesKeys.location(projectId, fileId ?? ""), queryFn: () => invoke("files.locate", projectId, fileId!), enabled: !!fileId, retry: false });

export const useFileHistory = (projectId: string, path: string | null) =>
  useQuery({ queryKey: filesKeys.history(projectId, path ?? ""), queryFn: () => invoke("files.history", projectId, path!), enabled: path !== null && path !== "", retry: false });

export const useFileConflicts = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: filesKeys.conflicts(projectId), queryFn: () => invoke("files.conflicts", projectId), enabled, retry: false });

export const useFilesBackends = () => useQuery({ queryKey: filesKeys.backends, queryFn: () => invoke("files.backends") });

/** Whether a backend's account is connected, and as whom. Never the secret. */
export const useFilesConnection = (backendId: string | undefined) =>
  useQuery({ queryKey: filesKeys.connection(backendId ?? ""), queryFn: () => invoke("files.connection", backendId!), enabled: !!backendId, retry: false });

export function useConnectFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; secret: string }) => invoke("files.connect", args.providerId, args.secret),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["files"] });
      void qc.invalidateQueries({ queryKey: ["storage"] });
    }
  });
}

export function useDisconnectFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backendId: string) => invoke("files.disconnect", backendId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["files"] });
      void qc.invalidateQueries({ queryKey: ["storage"] });
    }
  });
}

/** Imperative on purpose: nothing is listed until someone asks to choose. */
export const useBrowseFiles = () => useMutation({ mutationFn: (backendId: string) => invoke("files.browse", backendId) });

export const useDraftFiles = () => useMutation({ mutationFn: (args: { providerId: string; name: string }) => invoke("files.draft", args.providerId, args.name) });

/** Every mutation already lands through a service call that broadcasts `files.changed` on success — the app-wide listener in main.tsx invalidates from that. Invalidating again here would only race a second, redundant refetch against it, and do it needlessly on failure too. */
function useFilesMutation<A, R>(_projectId: string, fn: (args: A) => Promise<R>) {
  return useMutation({ mutationFn: fn });
}

export const useSyncFiles = (projectId: string) => useFilesMutation(projectId, () => invoke("files.sync", projectId));
export const useBindFiles = (projectId: string) => useFilesMutation(projectId, (args: { backendId: string; config: Record<string, unknown> }) => invoke("files.bind", projectId, args.backendId, args.config));
export const useUnbindFiles = (projectId: string) => useFilesMutation(projectId, () => invoke("files.unbind", projectId));
export const useMakeFolder = (projectId: string) => useFilesMutation(projectId, (path: string) => invoke("files.mkdir", projectId, path));
export const useMoveFile = (projectId: string) => useFilesMutation(projectId, (args: { from: string; to: string }) => invoke("files.move", projectId, args.from, args.to));
export const useCopyFile = (projectId: string) => useFilesMutation(projectId, (args: { from: string; to: string }) => invoke("files.copy", projectId, args.from, args.to));
export const useRemoveFile = (projectId: string) => useFilesMutation(projectId, (path: string) => invoke("files.remove", projectId, path));
export const useImportFiles = (projectId: string) => useFilesMutation(projectId, (args: { dir: string; sources: string[] }) => invoke("files.import", projectId, args.dir, args.sources));
export const useWriteFile = (projectId: string) => useFilesMutation(projectId, (args: { path: string; body: string; message?: string }) => invoke("files.write", projectId, args.path, args.body, { encoding: "utf8", message: args.message }));
export const useResolveConflict = (projectId: string) => useFilesMutation(projectId, (args: { path: string; choice: ConflictChoice }) => invoke("files.resolve", projectId, args.path, args.choice));
export const useResolveAllConflicts = (projectId: string) => useFilesMutation(projectId, (choice: ConflictChoice) => invoke("files.resolveAll", projectId, choice));

// ── clipboard: cut/copy paths, held app-wide like an OS clipboard ───────────

export interface FilesClipboardEntry {
  projectId: string;
  mode: "cut" | "copy";
  paths: string[];
}

let clipboardEntry: FilesClipboardEntry | null = null;
const clipboardListeners = new Set<() => void>();
const setClipboardEntry = (next: FilesClipboardEntry | null) => {
  clipboardEntry = next;
  for (const listener of clipboardListeners) listener();
};
const subscribeClipboard = (onChange: () => void) => {
  clipboardListeners.add(onChange);
  return () => void clipboardListeners.delete(onChange);
};

/** A single clipboard, scoped to this project: another project's cut or copy shows as empty here. */
export function useFilesClipboard(projectId: string) {
  const entry = useSyncExternalStore(subscribeClipboard, () => clipboardEntry);
  const active = entry && entry.projectId === projectId ? entry : null;
  return {
    entry: active,
    cut: (paths: string[]) => setClipboardEntry({ projectId, mode: "cut", paths }),
    copy: (paths: string[]) => setClipboardEntry({ projectId, mode: "copy", paths }),
    clear: () => setClipboardEntry(null)
  };
}

/** "brief (copy).md", or "brief (copy 2).md" when that is taken too — never overwrites what is there. */
export function uniqueDestPath(existing: Set<string>, dir: string, name: string): string {
  const join = (n: string) => (dir ? `${dir}/${n}` : n);
  if (!existing.has(join(name))) return join(name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${stem} (copy${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!existing.has(join(candidate))) return join(candidate);
  }
}

/** Moves (cut) or copies every clipboard path into `dir`, one at a time — each store mutation is its own version. */
export function usePasteFiles(projectId: string) {
  const move = useMoveFile(projectId);
  const copy = useCopyFile(projectId);
  return async (entry: FilesClipboardEntry, dir: string, existing: Set<string>): Promise<{ count: number; name: string }> => {
    const claimed = new Set(existing);
    let name = "";
    let count = 0;
    for (const src of entry.paths) {
      // A move that lands exactly where the file already is changes nothing — treat it as cancelled, not a rename into a duplicate.
      if (entry.mode === "cut" && (src === dir || parentOf(src) === dir)) {
        name = nameOf(src);
        continue;
      }
      const dest = uniqueDestPath(claimed, dir, nameOf(src));
      claimed.add(dest);
      if (entry.mode === "cut") await move.mutateAsync({ from: src, to: dest });
      else await copy.mutateAsync({ from: src, to: dest });
      name = nameOf(dest);
      count++;
    }
    return { count, name };
  };
}

/** Pin a file's latest version to a ticket as material or an output artifact. */
export function useAttachFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; path: string; role: "input" | "output"; name?: string }) => invoke("files.attach", projectId, args.itemId, { path: args.path, role: args.role, name: args.name }),
    onSettled: () => {
      invalidateFiles(qc, projectId);
      invalidateWorkspace(qc, projectId);
    }
  });
}

/** Pin several files to one ticket atomically. */
export function useAttachFiles(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; paths: string[]; role: "input" | "output" }) => invoke("files.attachMany", projectId, args.itemId, { paths: args.paths, role: args.role }),
    onSettled: () => {
      invalidateFiles(qc, projectId);
      invalidateWorkspace(qc, projectId);
    }
  });
}

export const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
