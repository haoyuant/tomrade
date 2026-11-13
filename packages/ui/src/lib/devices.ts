import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DispatchView } from "@tomradex/dispatch";
import type { DeviceSession, DeviceView, DevicesInfo } from "@tomradex/hub-cloud";
import { invoke } from "./api";
import { keys, useHubInfo } from "./queries";

/** The account's machines. Asked only where the account service runs; a change anywhere arrives as `devices.changed`. */
export function useDevices() {
  const hub = useHubInfo();
  return useQuery({ queryKey: keys.devices, queryFn: () => invoke("devices.info"), enabled: hub.data?.cloudEnabled === true, retry: false });
}

/** The account's tickets sent between its machines, newest first. Empty where nothing sends them. */
export function useDispatches() {
  const hub = useHubInfo();
  return useQuery({ queryKey: keys.dispatches, queryFn: () => invoke("dispatch.list").catch((): DispatchView[] => []), enabled: hub.data?.cloudEnabled === true, retry: false });
}

/** The newest request for a ticket: the one going, else the last word on it. */
export const dispatchOf = (dispatches: DispatchView[] | undefined, projectId: string, key: string): DispatchView | null =>
  (dispatches ?? []).find((d) => d.projectId === projectId && d.key === key) ?? null;

/** The label that says a ticket runs on any computer of a platform. */
export const PLATFORM_LABELS: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };
/** The label that names one computer for a ticket. */
export const deviceLabel = (name: string): string => `device:${name.trim().toLowerCase()}`;

/** Rename, remove and check again each answer with the list as it is afterwards. */
export function useDeviceActions() {
  const qc = useQueryClient();
  const took = (info: DevicesInfo) => qc.setQueryData(keys.devices, info);
  return {
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => invoke("devices.rename", id, name), onSuccess: took }),
    remove: useMutation({ mutationFn: (id: string) => invoke("devices.remove", id), onSuccess: took }),
    recheck: useMutation({ mutationFn: () => invoke("devices.recheck"), onSuccess: took })
  };
}

/** Another machine's session on this ticket: the one that is on, else the one seen last. */
export function elsewhereOn(devices: DeviceView[] | undefined, projectId: string, key: string): { device: DeviceView; session: DeviceSession } | null {
  const found = (devices ?? []).flatMap((device) => (device.self ? [] : device.sessions.filter((s) => s.projectId === projectId && s.key === key).map((session) => ({ device, session }))));
  found.sort((a, b) => Number(b.device.online) - Number(a.device.online) || (b.device.activityAt ?? 0) - (a.device.activityAt ?? 0));
  return found[0] ?? null;
}

/**
 * Whether to ask, once, if this computer should take work from the account's others: it has its place among
 * two or more, can say whether it accepts work, says it does not, and was never asked.
 */
export const shouldAskAccept = (info: DevicesInfo | undefined, asked: boolean): boolean =>
  !asked && info?.state === "ready" && info.devices.length >= 2 && info.devices.some((d) => d.self && d.accept?.on === false);

/** `here`, a device's id, or `platform:<name>` for any computer of a platform. */
export type RunTarget = string;

/** Why another computer cannot be sent a ticket of this project: it takes no work, or none for this project. Null when it can. */
export const whyNot = (device: DeviceView, projectId: string): "not-accepting" | "project" | null =>
  !device.accept?.on ? "not-accepting" : device.accept.projects === "all" || device.accept.projects.includes(projectId) ? null : "project";

/** The computers a ticket of this project can be sent to: the others that accept work for it. */
export const takers = (devices: DeviceView[] | undefined, projectId: string): DeviceView[] =>
  (devices ?? []).filter((d) => !d.self && !whyNot(d, projectId));

/**
 * What Start has to say of where a ticket runs.
 * - `hidden`: nothing yet, or nothing to offer: no account service here, the list not read, this computer still registering.
 * - `signed-out`, `alone`, `out`: only this computer, and what is missing: an account, a second computer, a place among the account's.
 * - `choose`: the other computers, each with why it cannot take the ticket, or null when it can.
 */
export type RunOnState =
  | { kind: "hidden" | "signed-out" | "alone" | "out" }
  | { kind: "choose"; others: { device: DeviceView; why: "not-accepting" | "project" | null }[] };

export function runOnState(cloudEnabled: boolean | undefined, info: DevicesInfo | undefined, projectId: string): RunOnState {
  if (!cloudEnabled || !info || info.state === "pending") return { kind: "hidden" };
  if (info.state === "signed-out") return { kind: "signed-out" };
  if (info.state !== "ready") return { kind: "out" };
  const others = info.devices.filter((d) => !d.self).map((device) => ({ device, why: whyNot(device, projectId) }));
  return others.length ? { kind: "choose", others } : { kind: "alone" };
}

/** What the ticket's labels say of where it should run: a `device:<name>` label, else a platform's (`windows`, `macos`, `linux`). */
export function targetOf(item: { labels: string[] }, devices: DeviceView[]): RunTarget | null {
  const labels = item.labels.map((l) => l.toLowerCase());
  const named = devices.find((d) => labels.includes(deviceLabel(d.name)));
  if (named) return named.id;
  const platform = Object.entries(PLATFORM_LABELS).find(([, label]) => labels.includes(label))?.[0];
  return platform && devices.some((d) => d.platform === platform) ? `platform:${platform}` : null;
}
