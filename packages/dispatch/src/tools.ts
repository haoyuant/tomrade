import type { Context } from "cordis";
import { z } from "zod";
import { languageTag } from "@tomradex/domain";
import type { DeviceView, DevicesInfo } from "@tomradex/hub-cloud";
import { defineTool, requireProjectId } from "@tomradex/tools";
import { PLATFORM_LABELS, unfit, type Unfit } from "./match.js";
import type { Queue } from "./queue.js";
import { DISPATCH_WORDS } from "./words.js";

interface ItemsHost { getByKey(projectId: string, key: string): { id: string; key: string; title: string } | null }
interface CloudHost { devicesInfo?(): DevicesInfo }

const PLATFORM_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
/** A platform as the system names it, from the label a ticket carries for it (`windows` → `win32`). */
const platformOf = (label: string): string | undefined => Object.entries(PLATFORM_LABELS).find(([, word]) => word === label)?.[0];

/** Why a machine cannot be sent a ticket, as an agent can pass it on. */
const WHY: Record<Unfit, string> = {
  excluded: "the project's rules keep work away from it",
  "not-accepting": "it does not accept work; that is turned on at that computer, under Settings → Devices, by the person",
  project: "it accepts work, but not for this project",
  "no-agent": "no coding agent is installed and signed in there",
  offline: "it is off: a ticket sent now waits for it, up to a day",
  busy: "it already runs as many sessions as it accepts: a ticket sent now waits"
};
const waits = (why: Unfit | null): why is "offline" | "busy" => why === "offline" || why === "busy";

/** Why nothing can be said of the account's machines here, or null when they can be read. */
function unavailable(info: DevicesInfo | undefined): string | null {
  if (!info) return "This Tomrade has no account service, so it knows no other computers.";
  if (info.state === "signed-out") return "Nobody is signed in on this computer. Devices need an account: the person signs in under Settings → Hub.";
  if (info.state === "pending") return "This computer is still registering with the account. Try again in a moment.";
  if (info.state === "removed") return "This computer was removed from the account's devices. Signing in again here brings it back.";
  if (info.state === "over-limit") return `The account's plan has no place for this computer${info.plan.limit === null ? "" : ` (${info.plan.limit} computers)`}. The person removes one under Settings → Devices, or subscribes.`;
  return null;
}

const going = (state: string): boolean => state === "queued" || state === "accepted" || state === "running";

/**
 * The account's machines and the queue between them, for an agent: which computers there are and which could take
 * a ticket, sending one with the person's yes, and taking it back. Whether this machine accepts work is not here:
 * that stays the person's own switch.
 */
export function registerTools(ctx: Context, queue: () => Queue): void {
  const tools = ctx.tools;
  const items = () => ctx.get("items") as ItemsHost | undefined;
  const info = () => (ctx.get("cloudHub") as CloudHost | undefined)?.devicesInfo?.();
  const words = () => DISPATCH_WORDS(languageTag((ctx.get("settings") as { locale(): unknown } | undefined)?.locale()));
  const ticket = (tool: string, projectId: string, key: string) => {
    const item = items()?.getByKey(projectId, key.toUpperCase());
    if (!item) throw new Error(`${tool}: no ticket ${key} in this project`);
    return item;
  };
  const nameOf = (devices: DeviceView[], id: string | null) => (id ? (devices.find((d) => d.id === id)?.name ?? id) : null);

  tools.kit("devices", "the account's other computers: which are on and take work, and sending a ticket to one");
  tools.register(
    defineTool({
      name: "list_devices",
      kit: "devices",
      title: "List the account's computers",
      readOnly: true,
      description:
        "The computers signed in to the person's account: which are online, their platform, the coding agents ready on each, whether each accepts work sent from the others and within what, and the tickets each works on. With a ticket key, also whether each other computer can take that ticket now and why not. Also lists the tickets recently sent between computers and how each stands. Use it before dispatch_ticket, and to answer where a ticket could run.",
      input: z.object({ key: z.string().min(1).optional().describe("A ticket key, e.g. TOM-42: adds whether each computer can take it"), projectId: z.string().optional() }),
      execute: (args, inv) => {
        const read = info();
        const why = unavailable(read);
        if (why) return { available: false, why };
        const projectId = args.key || inv.projectId || args.projectId ? requireProjectId("list_devices", args.projectId, inv) : undefined;
        const item = args.key && projectId ? ticket("list_devices", projectId, args.key) : null;
        const devices = read!.devices;
        return {
          available: true,
          devices: devices.map((d) => {
            const fit = item && !d.self ? unfit(d, projectId!) : null;
            return {
              id: d.id, name: d.name, thisComputer: d.self, platform: PLATFORM_LABELS[d.platform] ?? d.platform, online: d.online,
              ...(d.online ? {} : { lastSeen: new Date(d.lastSeenAt).toISOString() }),
              agents: d.agents.map((a) => ({ id: a.id, ready: a.ready })),
              acceptsWork: d.accept ? { on: d.accept.on, projects: d.accept.projects, ceiling: d.accept.ceiling, sessionsAtOnce: d.accept.concurrent } : null,
              workingOn: d.sessions.map((s) => ({ projectId: s.projectId, key: s.key, title: s.title, agent: s.agent, state: s.state })),
              ...(item && !d.self ? { canTake: !fit, ...(fit ? { why: WHY[fit] } : {}) } : {})
            };
          }),
          sent: queue().list().filter((r) => (!projectId || r.projectId === projectId) && (!item || r.key === item.key)).slice(0, 10).map((r) => ({
            id: r.id, key: r.key, to: nameOf(devices, r.toDevice) ?? `any ${PLATFORM_NAMES[r.toPlatform ?? ""] ?? r.toPlatform} computer`,
            ...(r.claimedBy ? { takenBy: nameOf(devices, r.claimedBy) } : {}), state: r.state, ...(r.reason ? { reason: r.reason } : {}), sentAt: new Date(r.createdAt).toISOString()
          })),
          note: "Whether a computer accepts work is its own setting, turned on at that computer by the person (Settings → Devices). No tool turns it on."
        };
      }
    })
  );

  tools.register(
    defineTool({
      name: "dispatch_ticket",
      kit: "devices",
      title: "Send a ticket to another computer",
      description:
        "Asks another of the account's computers to work a code ticket: a coding agent starts on it there, with that computer's own sign-in and within the limits that computer set, and the work comes back as commits and a pull request. Only when the person asked for it. They confirm before anything is sent: where Tomrade can ask them, it asks; elsewhere ask them yourself first and pass their yes, in their own words, as userSaid. Name one computer (to), or a platform for any computer of it. A computer that is off or full is sent to all the same and takes the ticket when it can, within a day; one that does not accept work is not sent to. Call list_devices first to see which can take it.",
      input: z.object({
        key: z.string().min(1).describe("The ticket key, e.g. TOM-42"),
        to: z.string().min(1).optional().describe("One computer, by its name or id as list_devices gives them"),
        platform: z.enum(["windows", "macos", "linux"]).optional().describe("Instead of `to`: any of the account's computers of this platform"),
        userSaid: z.string().trim().min(1).optional().describe("Only where Tomrade cannot ask the person itself: their own words agreeing to send this ticket there, quoted"),
        projectId: z.string().optional()
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("dispatch_ticket", args.projectId, inv);
        if (!args.to === !args.platform) throw new Error("dispatch_ticket: name one computer (to) or a platform, not both");
        const item = ticket("dispatch_ticket", projectId, args.key);
        const read = info();
        const down = unavailable(read);
        if (down) return { sent: false, why: down };
        const others = read!.devices.filter((d) => !d.self);
        let target: { to: string } | { platform: string };
        let where: string;
        let wait: string | null = null;
        if (args.to) {
          const wanted = args.to.trim().toLowerCase();
          const device = others.find((d) => d.id.toLowerCase() === wanted || d.name.trim().toLowerCase() === wanted);
          if (!device) return { sent: false, why: `No other computer of the account is called "${args.to}".`, computers: others.map((d) => d.name) };
          const fit = unfit(device, projectId);
          if (fit && !waits(fit)) return { sent: false, why: `${device.name} cannot take it: ${WHY[fit]}.` };
          if (fit) wait = `${device.name}: ${WHY[fit]}.`;
          target = { to: device.id };
          where = device.name;
        } else {
          const platform = platformOf(args.platform!)!;
          const pool = others.filter((d) => d.platform === platform);
          if (!pool.length) return { sent: false, why: `The account has no other ${PLATFORM_NAMES[platform]} computer.` };
          const fits = pool.map((d) => unfit(d, projectId));
          if (fits.every((fit) => fit && !waits(fit))) return { sent: false, why: `No ${PLATFORM_NAMES[platform]} computer can take it: ${pool.map((d, i) => `${d.name} — ${WHY[fits[i]!]}`).join("; ")}.` };
          if (!fits.includes(null)) wait = `No ${PLATFORM_NAMES[platform]} computer is free right now; the first that is takes it, within a day.`;
          target = { platform };
          where = words()("anyPlatform", { platform: PLATFORM_NAMES[platform]! });
        }
        if (inv.ask) {
          const w = words();
          if ((await inv.ask(w("askSend", { key: item.key, title: item.title, where }), [w("askYes"), w("askNo")])) !== w("askYes")) return { sent: false, why: "The person said no. Nothing was sent." };
        } else if (!args.userSaid) {
          throw new Error(
            "Tomrade cannot ask the person from here. Sending starts a coding agent on another computer: tell them which ticket goes to which computer and ask; once they agree, call dispatch_ticket again with their words in userSaid. They can also send it themselves from the ticket's Start, under Run on."
          );
        }
        const sent = await queue().send({ projectId, itemId: item.id, ...target });
        return {
          sent: true, id: sent.id, key: sent.key, to: where, state: sent.state, expiresAt: new Date(sent.expiresAt).toISOString(),
          ...(wait ? { waits: wait } : {}),
          note: "Nothing starts on this computer. The ticket's status follows git as usual. list_devices shows how the request stands; cancel_dispatch takes it back."
        };
      }
    })
  );

  tools.register(
    defineTool({
      name: "cancel_dispatch",
      kit: "devices",
      title: "Take back a ticket sent to another computer",
      description: "Takes back a ticket sent to another of the account's computers: a request still waiting is withdrawn, and a session already running there is stopped. Only when the person asks to take it back. What that session committed stays on its branch.",
      input: z.object({ key: z.string().min(1).describe("The ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("cancel_dispatch", args.projectId, inv);
        const item = ticket("cancel_dispatch", projectId, args.key);
        const live = queue().list().find((r) => r.projectId === projectId && r.key === item.key && going(r.state));
        if (!live) return { cancelled: false, why: `No request for ${item.key} is waiting or running.` };
        const after = (await queue().cancel(live.id)).find((r) => r.id === live.id);
        return { cancelled: after?.state === "cancelled", id: live.id, key: item.key, state: after?.state ?? live.state };
      }
    })
  );
}
