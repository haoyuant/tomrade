import { z } from "zod";
import type { InboxEntryInput, InboxSource } from "@tomradex/inbox";
import type { InboxApi } from "@tomradex/plugin-sdk";
import { COMMAND_MS, copy, type Facade } from "./shared.js";

/** A pull that hangs would hold up every later pull of the project's sources. */
const PULL_MS = 120_000;

const Entry = z.object({
  externalId: z.string().min(1),
  url: z.string().nullish(),
  kind: z.string().optional(),
  reporter: z.string().nullish(),
  title: z.string(),
  body: z.string().optional(),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
  receivedAt: z.number().finite()
});
const Pulled = z.union([
  z.array(Entry),
  z.object({
    entries: z.array(Entry),
    cursor: z.number().finite().nullable(),
    activity: z.array(z.object({ externalId: z.string().min(1), at: z.number().finite() })).optional(),
    state: z.unknown().optional(),
    warnings: z.array(z.string()).optional()
  })
]);

export const inboxApi = ({ host }: Facade): InboxApi => ({
  source: (spec) =>
    host.call(() => {
      host.own(spec.id, "inbox source");
      const label = `inbox source ${spec.id}`;
      const pull = host.back(spec.pull.bind(spec), `${label} pull`, { ms: PULL_MS });
      const available = spec.available ? host.back(spec.available.bind(spec), `${label} available`, { ms: COMMAND_MS }) : null;
      const reply = spec.reply ? host.back(spec.reply.bind(spec), `${label} reply`, { ms: COMMAND_MS }) : null;
      const setStatus = spec.setStatus ? host.back(spec.setStatus.bind(spec), `${label} setStatus`, { ms: COMMAND_MS }) : null;
      const source: InboxSource = {
        id: spec.id,
        title: host.say(spec.title),
        ...(spec.keyPattern ? { keyPattern: spec.keyPattern } : {}),
        ...(available ? { available: (projectId) => available(projectId) } : {}),
        pull: async (scope) => {
          const parsed = Pulled.safeParse(await pull(copy(scope)));
          if (!parsed.success) throw new Error(`${spec.id} pulled something that is not inbox entries: ${parsed.error.issues.map((i) => `${i.path.join(".") || "result"}: ${i.message}`).join("; ")}`);
          return parsed.data as InboxEntryInput[] | { entries: InboxEntryInput[]; cursor: number | null };
        },
        ...(reply ? { reply: (entry, text) => reply(copy(entry), text) } : {}),
        ...(setStatus ? { setStatus: (entry, change) => setStatus(copy(entry), copy(change)) } : {}),
        ...(spec.options ? { options: spec.options.map((o) => ({ id: o.id, title: host.say(o.title), ...(o.description ? { description: host.say(o.description) } : {}), default: o.default })) } : {})
      };
      return host.disposerOf(host.svc("inbox").source(source));
    })
});
