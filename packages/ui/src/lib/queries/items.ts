import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { CLOSED_STATUSES, type ClosedStatus, type ClosedWindow, type CreateItemInput, type FilterClause, type Item, type Patch } from "@tomradex/domain";
import { invoke } from "../api";
import { closedWindowOf } from "../closedWindow";
import { invalidateWorkspace } from "./invalidate";
import { keys } from "./keys";
import { useSettings } from "./settings";

/** This project's window over done and cancelled tickets; null until the settings are read. */
export function useClosedWindow(projectId: string): ClosedWindow | null {
  const settings = useSettings();
  const known = !!settings.data || settings.isError;
  return useMemo(() => (known ? closedWindowOf(settings.data, projectId) : null), [known, settings.data, projectId]);
}

/**
 * The project's items as the renderer holds them: every epic and open ticket,
 * and only the newest done and cancelled ones (see useClosedPages for more).
 * Not every ticket — a count or an aggregate asks the main process.
 */
export function useItems(projectId: string) {
  const window = useClosedWindow(projectId);
  return useQuery({
    queryKey: keys.itemsWindow(projectId, window?.limit ?? null, window?.days ?? null),
    queryFn: () => invoke("items.window", projectId, window!),
    enabled: !!window
  });
}

/** Every item, done and cancelled included: only for a dialog that has to see them all. The cache goes when it closes. */
export const useAllItems = (projectId: string, enabled = true) =>
  useQuery({ queryKey: keys.itemsAll(projectId), queryFn: () => invoke("items.list", { projectId }), gcTime: 0, enabled });

/**
 * Of `ids`, the items `held` has, plus those asked for one by one because the
 * window left them out (an old done blocker, say). Absent until they arrive.
 */
export function useItemsById(projectId: string, held: Item[], ids: string[]): Item[] {
  const byId = new Map(held.map((i) => [i.id, i]));
  const missing = ids.filter((id) => !byId.has(id));
  const fetched = useQueries({ queries: missing.map((id) => ({ queryKey: keys.item(projectId, id), queryFn: () => invoke("items.get", projectId, id) })) });
  const got = new Map(fetched.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : [])));
  return ids.flatMap((id) => byId.get(id) ?? got.get(id) ?? []);
}

/** One item by id or key from `held`, else from the main process once `held` has loaded without it. */
export function useHeldItem(projectId: string, held: Item[] | undefined, idOrKey: string | null | undefined) {
  const local = idOrKey ? held?.find((i) => i.id === idOrKey || i.key === idOrKey) : undefined;
  const remote = useItem(projectId, idOrKey, !!held && !local);
  return { item: local ?? remote.data ?? undefined, loading: !held || (!local && remote.isLoading && remote.fetchStatus !== "idle") };
}

/** One item by id or key, asked only when `enabled` — when the window has no copy of it. */
export const useItem = (projectId: string, idOrKey: string | null | undefined, enabled: boolean) =>
  useQuery({ queryKey: keys.item(projectId, idOrKey ?? ""), queryFn: () => invoke("items.get", projectId, idOrKey!), enabled: enabled && !!idOrKey });

export const useEpicProgress = (projectId: string) => useQuery({ queryKey: keys.epicProgress(projectId), queryFn: () => invoke("items.epicProgress", projectId) });

const statusIs = (status: ClosedStatus): FilterClause => ({ field: "status", op: "in", values: [status] });

/** Each closed status's true count under a filter and search: what the board's closed columns head with. */
export function useClosedTotals(projectId: string, filter: FilterClause[], search: string, enabled = true): Partial<Record<ClosedStatus, number>> {
  const results = useQueries({
    queries: CLOSED_STATUSES.map((status) => {
      const query = { projectId, filter: [...filter, statusIs(status)], search: search || undefined, ticketsOnly: true };
      return { queryKey: keys.itemQuery(projectId, "count", query), queryFn: () => invoke("items.count", query), placeholderData: keepPreviousData, enabled };
    })
  });
  const [done, cancelled] = [results[0]?.data, results[1]?.data];
  return useMemo(() => ({ ...(done === undefined ? {} : { done }), ...(cancelled === undefined ? {} : { cancelled }) }), [done, cancelled]);
}

/** A closed status's newest tickets under a filter and search, as many as `limits` asks for each: the pages "load more" adds. */
export function useClosedPages(projectId: string, filter: FilterClause[], search: string, limits: Partial<Record<ClosedStatus, number>>) {
  return useQueries({
    queries: CLOSED_STATUSES.map((status) => {
      const query = { projectId, filter: [...filter, statusIs(status)], search: search || undefined, ticketsOnly: true, newestClosedFirst: true, limit: limits[status] ?? 0 };
      return { queryKey: keys.itemQuery(projectId, "page", query), queryFn: () => invoke("items.query", query), enabled: !!limits[status],
        // The page before stays up while the next loads, so the column does not blink; a reset drops it.
        placeholderData: (previous: Item[] | undefined) => (limits[status] ? previous : undefined) };
    })
  });
}

/** The most a search brings back of tickets the window left out. */
const FOUND_LIMIT = 200;

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Done and cancelled tickets a search matches, whatever their age: a search reaches past the window, by words or by key. */
export const useClosedFound = (projectId: string, search: string) => {
  const text = search.trim();
  const query = { projectId, search: text, filter: [{ field: "status", op: "in", values: [...CLOSED_STATUSES] }] as FilterClause[], ticketsOnly: true, limit: FOUND_LIMIT };
  return useQuery({
    queryKey: keys.itemQuery(projectId, "found", query),
    queryFn: async () => {
      const [found, byKey] = await Promise.all([invoke("items.query", query), TICKET_KEY.test(text) ? invoke("items.get", projectId, text) : null]);
      return byKey && byKey.kind === "ticket" && !found.some((i) => i.id === byKey.id) ? [byKey, ...found] : found;
    },
    enabled: !!text
  });
};

/** How many tickets each filter holds, by its id, counted in SQL: the window would undercount. */
export function useTicketCounts(projectId: string, specs: { id: string; filter: FilterClause[] }[]): Record<string, number> {
  const counts = useQuery({
    queryKey: keys.itemQuery(projectId, "ticketCounts", specs),
    queryFn: async () => Object.fromEntries(await Promise.all(specs.map(async ({ id, filter }) => [id, await invoke("items.count", { projectId, filter, ticketsOnly: true })] as const))),
    placeholderData: keepPreviousData
  });
  return counts.data ?? NO_COUNTS;
}

const NO_COUNTS: Record<string, number> = {};
export const useLabels = (projectId: string) => useQuery({ queryKey: keys.labels(projectId), queryFn: () => invoke("items.labels", projectId) });

/**
 * A ticket this window just wrote, put in every list that holds it. Asking again is left to the write's own
 * broadcast (items.changed, within 100 ms), which every window hears: asking here too fetched the board twice.
 */
export function putItem(qc: QueryClient, projectId: string, item: Item): void {
  qc.setQueriesData({ queryKey: keys.items(projectId) }, (data: unknown) => {
    if (Array.isArray(data)) return data.some((i: Item | undefined) => i?.id === item.id) ? data.map((i: Item | undefined) => (i?.id === item.id ? item : i)) : data;
    return data && typeof data === "object" && (data as Item).id === item.id ? item : data;
  });
}

/** A ticket purged here, out of every list that held it; the broadcast asks again as with `putItem`. */
function dropItem(qc: QueryClient, projectId: string, id: string): void {
  qc.setQueriesData({ queryKey: keys.items(projectId) }, (data: unknown) => (Array.isArray(data) ? data.filter((i: Item | undefined) => i?.id !== id) : data));
}

export function useCreateItem(projectId: string) {
  return useMutation({
    mutationFn: (input: Omit<CreateItemInput, "by">) => invoke("items.create", { ...input, projectId })
  });
}

/** A refusal re-fetches here: nothing was written, so no broadcast comes, and the retry needs a fresh version or it is refused for ever. */
export function usePatchItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Patch; baseVersion: number }) => invoke("items.update", projectId, args.id, args.patch, args.baseVersion),
    onSuccess: (item) => putItem(qc, projectId, item),
    onError: () => invalidateWorkspace(qc, projectId)
  });
}

/** The permanent one: nothing survives it, so the caller confirms first and never offers an Undo. */
export function usePurgeItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; baseVersion: number }) => invoke("items.purge", projectId, args.id, args.baseVersion),
    onSuccess: (_done, args) => dropItem(qc, projectId, args.id),
    onError: () => invalidateWorkspace(qc, projectId)
  });
}
