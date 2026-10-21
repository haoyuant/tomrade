import type { DbApi, SqlParams } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

const spread = (params: SqlParams | undefined): unknown[] => (params === undefined ? [] : Array.isArray(params) ? params : [params]);

export const dbApi = ({ host, ns }: Facade): DbApi => {
  const db = () => host.svc("db");
  const handle = (target: string) => (target === "hub" ? db().hub : db().for(target));
  return {
    migrate: (steps, opts) =>
      host.call(() => {
        db().migrate(ns, steps, opts);
      }),
    all: <T>(target: string, sql: string, params?: SqlParams) => host.call(() => handle(target).prepare(sql).all(...spread(params)) as T[]),
    get: <T>(target: string, sql: string, params?: SqlParams) => host.call(() => handle(target).prepare(sql).get(...spread(params)) as T | undefined),
    run: (target, sql, params) =>
      host.call(() => {
        const info = handle(target).prepare(sql).run(...spread(params));
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      }),
    batch: (target, statements) => host.call(() => handle(target).transaction(() => statements.map((s) => ({ changes: handle(target).prepare(s.sql).run(...spread(s.params)).changes })))),
    isOpen: (projectId) => host.call(() => db().has(projectId))
  };
};
