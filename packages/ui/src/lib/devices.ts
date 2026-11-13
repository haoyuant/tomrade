import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DispatchView } from "@tomradex/dispatch";
import { match, unfit, type MatchRole } from "@tomradex/dispatch/match";
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

/**
 * What the status bar says of the account's computers: how many are on, of how many, and which. Null until
 * this computer has its place among two or more: one computer alone has nothing to say.
 */
export function devicesStatus(info: DevicesInfo | undefined): { online: number; total: number; names: string[] } | null {
  if (info?.state !== "ready" || info.devices.length < 2) return null;
  const on = info.devices.filter((d) => d.online);
  return { online: on.length, total: info.devices.length, names: on.map((d) => d.name) };
}

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

/** Why a computer can never be sent a ticket as things stand, as opposed to having only to come on or free up. */
export type Unable = "not-accepting" | "project" | "role-agent" | "role-limit";

/** A role as far as choosing a computer reads it; null where the ticket is worked as no particular role. */
export type RunRole = MatchRole | null | undefined;

/**
 * Why another computer cannot be sent a ticket of this project: it takes no work, or none for this project, or
 * (worked as a role) it has none of the role's agents, or lets a sent ticket do less than the role allows. Null when it can.
 */
export function whyNot(device: DeviceView, projectId: string, role?: RunRole): Unable | null {
  const why = unfit(device, projectId, [], role);
  return why === "not-accepting" || why === "project" || why === "role-agent" || why === "role-limit" ? why : null;
}

/** The computers a ticket of this project can be sent to: the others that accept work for it and can work it as the role. */
export const takers = (devices: DeviceView[] | undefined, projectId: string, role?: RunRole): DeviceView[] =>
  (devices ?? []).filter((d) => !d.self && !whyNot(d, projectId, role));

/** What a ticket's label asks for and cannot have: the label, the platform it names (null: one computer, by `name`), and why. */
export interface LabelMiss {
  label: string;
  platform: string | null;
  name: string;
  why: "nobody" | "not-accepting" | "project" | "no-agent" | "role-agent" | "role-limit";
}

/**
 * A ticket whose label asks for another computer, or another platform, that cannot take it: by the same rules
 * that place tickets everywhere else. Null when the labels ask for nothing, for this computer, or for one that
 * can take it or has only to come on or free up; and until this computer has its place among the account's.
 */
export function labelMiss(item: { labels: string[] }, projectId: string, info: DevicesInfo | undefined, role?: RunRole): LabelMiss | null {
  if (info?.state !== "ready") return null;
  const found = match({ projectId, labels: item.labels, role }, info.devices);
  if (found.kind !== "none" || found.why === "excluded" || found.why === "offline" || found.why === "busy") return null;
  // What the role asks of a computer stands in for the ticket's labels.
  const named = role?.needs.device ? true : role?.needs.platform ? false : item.labels.some((l) => l.trim().toLowerCase().startsWith("device:"));
  const platform = named ? null : (Object.entries(PLATFORM_LABELS).find(([, label]) => label === found.wanted)?.[0] ?? null);
  return { label: named ? `device:${found.wanted}` : found.wanted, platform, name: found.name ?? found.wanted, why: found.why };
}

/**
 * Whether a ticket's labels ask for another computer than this one, whether or not one can take it now: Start
 * then asks where it runs before starting it here. False until this computer has its place among the account's.
 */
export const asksElsewhere = (item: { labels: string[] }, projectId: string, info: DevicesInfo | undefined, role?: RunRole): boolean =>
  info?.state === "ready" && match({ projectId, labels: item.labels, role }, info.devices).kind !== "here";

/**
 * What Start has to say of where a ticket runs.
 * - `hidden`: nothing yet, or nothing to offer: no account service here, the list not read, this computer still registering.
 * - `signed-out`, `alone`, `out`: only this computer, and what is missing: an account, a second computer, a place among the account's.
 * - `choose`: the other computers, each with why it cannot take the ticket, or null when it can.
 */
export type RunOnState =
  | { kind: "hidden" | "signed-out" | "alone" | "out" }
  | { kind: "choose"; others: { device: DeviceView; why: Unable | null }[] };

export function runOnState(cloudEnabled: boolean | undefined, info: DevicesInfo | undefined, projectId: string, role?: RunRole): RunOnState {
  if (!cloudEnabled || !info || info.state === "pending") return { kind: "hidden" };
  if (info.state === "signed-out") return { kind: "signed-out" };
  if (info.state !== "ready") return { kind: "out" };
  const others = info.devices.filter((d) => !d.self).map((device) => ({ device, why: whyNot(device, projectId, role) }));
  return others.length ? { kind: "choose", others } : { kind: "alone" };
}

/**
 * What says where the ticket should run: what its role asks of a computer, else its labels: a `device:<name>` label,
 * else a platform's (`windows`, `macos`, `linux`).
 */
export function targetOf(item: { labels: string[] }, devices: DeviceView[], role?: RunRole): RunTarget | null {
  const labels = role?.needs.device ? [deviceLabel(role.needs.device)] : role?.needs.platform && PLATFORM_LABELS[role.needs.platform] ? [PLATFORM_LABELS[role.needs.platform]!] : item.labels.map((l) => l.toLowerCase());
  const named = devices.find((d) => labels.includes(deviceLabel(d.name)));
  if (named) return named.id;
  const platform = Object.entries(PLATFORM_LABELS).find(([, label]) => labels.includes(label))?.[0];
  return platform && devices.some((d) => d.platform === platform) ? `platform:${platform}` : null;
}
