import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { TurnInput } from "@tomradex/agent";
import { contract } from "@tomradex/contracts";
import { engineLocale, RpcError, spawnCli, stopCli, type JsonLinePeer } from "@tomradex/engine-kit";
import type { AcpAgent, AcpOptions, Catalog } from "./agent.js";
import { acpConnection } from "./connection.js";

type Json = Record<string, any>;

/** Session settings by what they are: agents name them differently but tag them with these categories. */
const SETTINGS = {
  mode: { category: "mode", ids: ["mode"] },
  model: { category: "model", ids: ["model"] },
  effort: { category: "thought_level", ids: ["reasoning_effort", "effort", "thought_level"] }
};
export type Setting = keyof typeof SETTINGS;

/** A select's choices, its groups flattened. */
export const choicesOf = (option: Json): Json[] => (option.options ?? []).flatMap((entry: Json) => (Array.isArray(entry.options) ? entry.options : [entry]));

export const optionOf = (config: Json[], setting: Setting): Json | undefined => {
  const { category, ids } = SETTINGS[setting];
  return config.find((option) => option.type === "select" && (option.category === category || ids.includes(option.id)));
};

/** A choice's name, with a short description such as a credit multiplier. */
const labelOf = (value: string, name?: string, description?: string | null): string | undefined => {
  const base = name && name !== value ? name : undefined;
  if (description && description.length <= 24) return `${base ?? value} · ${description}`;
  return base;
};

/**
 * The models and efforts a session offers, through its config options or the older `models` field; empty when it offers none.
 * `defaults` is what the session opened with — the agent's own choice as long as Tomrade has not set one, so the caller
 * keeps only the knobs it left alone.
 */
export function advertised(config: Json[], models?: Json): Partial<Catalog> {
  const model = optionOf(config, "model");
  const listed = model
    ? choicesOf(model).map((choice) => ({ value: String(choice.value), label: labelOf(String(choice.value), choice.name, choice.description) }))
    : (models?.availableModels ?? []).map((m: Json) => ({ value: String(m.modelId), label: labelOf(String(m.modelId), m.name, m.description) }));
  const effort = optionOf(config, "effort");
  const current = (value: unknown): string | undefined => (typeof value === "string" || typeof value === "number") && String(value) ? String(value) : undefined;
  const defaults = { model: current(model ? model.currentValue : models?.currentModelId), effort: current(effort?.currentValue) };
  return {
    ...(listed.length ? { models: listed } : {}),
    ...(effort ? { efforts: choicesOf(effort).map((choice) => ({ value: String(choice.value), label: labelOf(String(choice.value), choice.name) })) } : {}),
    ...(defaults.model || defaults.effort ? { defaults: { ...(defaults.model ? { model: defaults.model } : {}), ...(defaults.effort ? { effort: defaults.effort } : {}) } } : {})
  };
}

/** Tomrade's data folder; null when it keeps nothing on disk (tests, a database in memory). */
function dataDir(ctx: Context): string | null {
  const dir = contract(ctx, "db")?.config.dir;
  return dir && dir !== ":memory:" ? dir : null;
}

/** What each agent's sessions offered, kept across restarts so the picks are there before the first turn. */
export function keptCatalogs(ctx: Context) {
  const file = () => {
    const dir = dataDir(ctx);
    return dir ? path.join(dir, "acp-models.json") : null;
  };
  const all = (at: string): Record<string, Partial<Catalog>> => {
    try {
      return JSON.parse(fs.readFileSync(at, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    read(id: string): Partial<Catalog> {
      const at = file();
      return at ? (all(at)[id] ?? {}) : {};
    },
    write(id: string, catalog: Catalog): void {
      const at = file();
      if (!at) return;
      try {
        fs.writeFileSync(at, `${JSON.stringify({ ...all(at), [id]: { models: catalog.models, efforts: catalog.efforts, ...(catalog.defaults ? { defaults: catalog.defaults } : {}) } }, null, 2)}\n`);
      } catch {
        // Only the next restart's picks miss it.
      }
    }
  };
}

/**
 * One agent process for a single exchange, then stopped: it runs in a folder
 * of Tomrade's own, so no project's history gains its sessions, and is handed
 * no MCP server.
 */
export async function oneShot<T>(ctx: Context, agent: AcpAgent<any>, options: AcpOptions, signal: AbortSignal, why: string, body: (conn: JsonLinePeer, child: ChildProcessWithoutNullStreams, cwd: string) => Promise<T>): Promise<T> {
  const cwd = path.join(dataDir(ctx) ?? os.tmpdir(), "acp-models");
  fs.mkdirSync(cwd, { recursive: true });
  // The agents' args and env read no turn; a turn's folder is all this one has.
  const input = { cwd } as TurnInput;
  const launch = await agent.cli.launch(options.command);
  const child = spawnCli(launch, agent.args(input, options), { cwd, env: { ...process.env, ...agent.env?.(input, options) }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const conn = acpConnection(child, agent.title, engineLocale(ctx)).onRequest((method) => Promise.reject(new RpcError(`Tomrade does not offer ${method}`, -32601)));
  const stop = () => {
    conn.close(new Error(`${agent.title} was only asked ${why}`));
    child.stdin.end();
    stopCli(child, "SIGTERM");
    setTimeout(() => stopCli(child, "SIGKILL"), 3000).unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await body(conn, child, cwd);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

export const CLIENT_INFO = { name: "tomrade", title: "Tomrade", version: "1" };

/** Opens one session only to read what the agent offers. */
export function askCatalog(ctx: Context, agent: AcpAgent<any>, options: AcpOptions, signal: AbortSignal): Promise<Partial<Catalog>> {
  return oneShot(ctx, agent, options, signal, "for its models", async (conn, _child, cwd) => {
    await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO }, 120_000);
    const session = await conn.request("session/new", { cwd, mcpServers: [] }, 120_000);
    return advertised(Array.isArray(session?.configOptions) ? session.configOptions : [], session?.models);
  });
}
