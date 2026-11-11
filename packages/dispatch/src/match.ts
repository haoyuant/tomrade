/** A machine of the account, as much as matching reads of it. */
export interface MatchDevice {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
  platform: string;
  agents: { id: string; ready: boolean }[];
  repos: string[];
  accept?: { on: boolean; projects: "all" | string[]; concurrent: number };
  /** What it works on now, as it last said. */
  sessions: unknown[];
}

/** A ticket, as much as matching reads of it. */
export interface MatchTicket {
  projectId: string;
  labels: string[];
  /** The repository its workstream stands for, when it has one. */
  remote?: string | null;
}

/** Why a machine cannot be sent a ticket at all, or not right now. */
export type Unfit = "excluded" | "not-accepting" | "project" | "no-agent" | "offline" | "busy";

/**
 * Where a ticket should run.
 * - `here`: on this machine — nothing says otherwise, or this machine is what its label asks for.
 * - `send`: on another machine that can take it now. `clone`: it has no checkout of the repository yet.
 * - `wait`: the right machine is off or full: sent, it waits there.
 * - `none`: its label asks for a machine nobody has, or one that cannot take it: it stays here, with why.
 */
export type Match =
  | { kind: "here"; by: "none" | "label" }
  | { kind: "send"; device: string; name: string; by: "label" | "model"; clone: boolean }
  | { kind: "wait"; device: string; name: string; by: "label"; why: "offline" | "busy" }
  | { kind: "none"; by: "label"; wanted: string; why: Unfit | "nobody"; name?: string };

/** The label that says a ticket runs on any machine of a platform. */
export const PLATFORM_LABELS: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };
/** The label that names one machine for a ticket. */
export const deviceLabel = (name: string): string => `device:${name.trim().toLowerCase()}`;

/** Two spellings of one repository read the same: no scheme, no user, no `.git`, no trailing slash, no case. */
const repoKey = (remote: string): string =>
  remote.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "").replace(":", "/").replace(/\.git$/, "").replace(/\/+$/, "");

const hasRepo = (device: MatchDevice, remote?: string | null): boolean => !!remote && device.repos.some((r) => repoKey(r) === repoKey(remote));

/** Why a machine cannot take a ticket of this project, hard reasons first; null when it can, now. */
export function unfit(device: MatchDevice, projectId: string, excluded: readonly string[] = []): Unfit | null {
  const out = excluded.map((name) => name.trim().toLowerCase());
  if (out.includes(device.name.trim().toLowerCase()) || out.includes(device.id.toLowerCase())) return "excluded";
  if (!device.accept?.on) return "not-accepting";
  if (device.accept.projects !== "all" && !device.accept.projects.includes(projectId)) return "project";
  if (!device.agents.some((a) => a.ready)) return "no-agent";
  if (!device.online) return "offline";
  if (device.sessions.length >= device.accept.concurrent) return "busy";
  return null;
}
const soft = (why: Unfit | null): why is "offline" | "busy" => why === "offline" || why === "busy";

/** The one to send to among machines that could take it: one that has the repository, then the least busy, then by name. */
const best = (devices: MatchDevice[], remote?: string | null): MatchDevice | undefined =>
  [...devices].sort((a, b) => Number(hasRepo(b, remote)) - Number(hasRepo(a, remote)) || a.sessions.length - b.sessions.length || a.name.localeCompare(b.name))[0];

/**
 * Where a ticket should run, by rules alone: its labels (`device:<name>`, or a platform's), which machines accept
 * work for its project, have a ready agent, are on and have room, and which have its repository. `excluded`: machines
 * the project's rules keep work away from. `model`: a machine a model would pick — heard only when no label speaks,
 * and only for a machine the rules allow.
 */
export function match(ticket: MatchTicket, devices: readonly MatchDevice[], opts: { excluded?: readonly string[]; model?: string | null } = {}): Match {
  const labels = ticket.labels.map((l) => l.trim().toLowerCase());
  const self = devices.find((d) => d.self);
  const others = devices.filter((d) => !d.self);
  const fit = (d: MatchDevice) => unfit(d, ticket.projectId, opts.excluded);

  const named = labels.find((l) => l.startsWith("device:"));
  if (named) {
    if (self && deviceLabel(self.name) === named) return { kind: "here", by: "label" };
    const device = others.find((d) => deviceLabel(d.name) === named);
    const wanted = named.slice("device:".length);
    if (!device) return { kind: "none", by: "label", wanted, why: "nobody" };
    const why = fit(device);
    if (!why) return { kind: "send", device: device.id, name: device.name, by: "label", clone: !hasRepo(device, ticket.remote) };
    return soft(why) ? { kind: "wait", device: device.id, name: device.name, by: "label", why } : { kind: "none", by: "label", wanted, why, name: device.name };
  }

  const platform = Object.entries(PLATFORM_LABELS).find(([, label]) => labels.includes(label))?.[0];
  if (platform) {
    if (self?.platform === platform) return { kind: "here", by: "label" };
    const wanted = PLATFORM_LABELS[platform]!;
    const pool = others.filter((d) => d.platform === platform);
    if (!pool.length) return { kind: "none", by: "label", wanted, why: "nobody" };
    const ready = best(pool.filter((d) => !fit(d)), ticket.remote);
    if (ready) return { kind: "send", device: ready.id, name: ready.name, by: "label", clone: !hasRepo(ready, ticket.remote) };
    // One that is only off or full: a machine that is on and full before one that is off.
    const later = best(pool.filter((d) => fit(d) === "busy"), ticket.remote) ?? best(pool.filter((d) => fit(d) === "offline"), ticket.remote);
    if (later) return { kind: "wait", device: later.id, name: later.name, by: "label", why: fit(later) as "offline" | "busy" };
    const first = pool[0]!;
    return { kind: "none", by: "label", wanted, why: fit(first)!, name: first.name };
  }

  // No label: here, unless a model named a machine the rules allow.
  const picked = opts.model ? others.find((d) => d.name.trim().toLowerCase() === opts.model!.trim().toLowerCase() || d.id === opts.model) : undefined;
  if (picked && !fit(picked)) return { kind: "send", device: picked.id, name: picked.name, by: "model", clone: !hasRepo(picked, ticket.remote) };
  return { kind: "here", by: "none" };
}
