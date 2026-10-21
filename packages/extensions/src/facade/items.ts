import { extensionScope, type WriteIntent } from "@tomradex/write";
import type { ItemsApi, PendingWrite } from "@tomradex/plugin-sdk";
import { authorFor, scopeFor } from "../scope.js";
import { copy, type Facade } from "./shared.js";

/**
 * A write gate is asked inside the write's transaction, so it answers at once: a throw refuses the
 * write, and a Promise is not waited for. It sees a copy, so no change of its reaches later policies.
 */
const judge = ({ host, ns }: Facade, check: (write: PendingWrite) => unknown, intent: WriteIntent): void => {
  const write: PendingWrite = copy({
    projectId: intent.projectId, entity: intent.entity, op: intent.op, id: intent.id, by: intent.by, via: intent.via ?? null, runId: intent.runId ?? null,
    baseVersion: intent.baseVersion ?? null, before: intent.before, after: intent.after, patch: intent.patch ?? null
  });
  const answer = extensionScope.run(scopeFor(ns), () => check(write));
  if (typeof (answer as PromiseLike<unknown> | undefined)?.then === "function") {
    Promise.resolve(answer).catch(() => {});
    host.logger.warn(`${host.identity.id} write gate answered with a Promise; a write gate must answer at once, so ${intent.entity} ${intent.id} was written without its answer`);
  }
};

export const itemsApi = (facade: Facade): ItemsApi => {
  const { host, ns } = facade;
  const items = () => host.svc("items");
  return {
    list: (filter) => host.call(() => items().list(filter ?? {})),
    query: (q) => host.call(() => items().query(q)),
    get: (projectId, id) => host.call(() => items().get(projectId, id)),
    getByKey: (projectId, key) => host.call(() => items().getByKey(projectId, key)),
    create: (input) => host.call(() => items().create({ ...input, by: authorFor(ns) })),
    update: (projectId, id, patch, opts) => host.call(() => items().update(projectId, id, patch, authorFor(ns), opts)),
    delete: (projectId, id) => host.call(() => items().delete(projectId, id, authorFor(ns))),
    addRelation: (projectId, id, blockedId) => host.call(() => items().addRelation(projectId, id, blockedId, authorFor(ns))),
    removeRelation: (projectId, id, blockedId) => host.call(() => items().removeRelation(projectId, id, blockedId, authorFor(ns))),
    labels: (projectId) => host.call(() => items().labelsFor(projectId)),
    gate: (check) =>
      host.call(() => {
        items(); // refused, like every items call, unless the plugin named "items"
        return host.disposerOf(
          host.ctx.on("write/pre-commit", (intent, next) => {
            judge(facade, check, intent);
            return next();
          })
        );
      })
  };
};
