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

/** `here`, a device's id, or `platform:<name>` for any computer of a platform. */
export type RunTarget = string;

/** The computers a ticket of this project can be sent to: the others that accept work for it. */
export const takers = (devices: DeviceView[] | undefined, projectId: string): DeviceView[] =>
  (devices ?? []).filter((d) => !d.self && d.accept?.on && (d.accept.projects === "all" || d.accept.projects.includes(projectId)));

/** What the ticket's labels say of where it should run: a `device:<name>` label, else a platform's (`windows`, `macos`, `linux`). */
export function targetOf(item: { labels: string[] }, devices: DeviceView[]): RunTarget | null {
  const labels = item.labels.map((l) => l.toLowerCase());
  const named = devices.find((d) => labels.includes(deviceLabel(d.name)));
  if (named) return named.id;
  const platform = Object.entries(PLATFORM_LABELS).find(([, label]) => labels.includes(label))?.[0];
  return platform && devices.some((d) => d.platform === platform) ? `platform:${platform}` : null;
}
