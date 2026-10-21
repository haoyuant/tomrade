import type { Engine, EngineLocal, EngineRegistration, EngineTerminal, FlatEngineMembers } from "./engine.js";

const FLAT_LOCAL = ["checkCli", "setup", "picks", "diagnostics", "commands", "mcpLink"] as const;
const FLAT = ["terminalOnly", "terminalViaLink", "terminalClaims", "steers", ...FLAT_LOCAL] as const;

type Given = Omit<Engine, "terminal"> & FlatEngineMembers & { terminal?: boolean | EngineTerminal };

/**
 * The engine in the grouped shape, whichever shape it was given in: plugins
 * built before the grouping still register flat members. Everything past
 * registration reads only the grouped ones.
 */
export function normalizeEngine(given: EngineRegistration): Engine {
  const flat = given as Given;
  if (typeof flat.terminal !== "boolean" && !FLAT.some((key) => key in flat)) return given as Engine;
  // Copied by descriptor, so a getter (a title in the person's language) stays live.
  const descriptors = Object.getOwnPropertyDescriptors(flat) as Record<string, PropertyDescriptor>;
  for (const key of FLAT) delete descriptors[key];
  if (typeof flat.terminal === "boolean") delete descriptors.terminal;
  const engine = Object.create(Object.getPrototypeOf(flat) as object | null, descriptors) as Engine;
  if (typeof flat.terminal !== "object") {
    engine.terminal = {
      mode: flat.terminalOnly ? "only" : flat.terminal === false ? "none" : "handoff",
      ...(flat.terminalViaLink ? { via: "link" as const } : {}),
      ...(flat.terminalClaims ? { claims: true } : {})
    };
  }
  if (flat.steers && !engine.steering) engine.steering = "queue";
  const local: EngineLocal = Object.fromEntries(FLAT_LOCAL.filter((key) => flat[key] !== undefined).map((key) => [key, flat[key]]));
  if (Object.keys(local).length) engine.local = { ...local, ...flat.local };
  return engine;
}

/** The engine in the flat names plugin scenarios read (`localAgents.engine`), as they were before the grouping. */
export function flatEngineView(engine: Engine): Record<string, unknown> {
  const { turn: _turn, available: _available, options, terminal, steering, local, ...rest } = engine;
  const mode = terminal?.mode ?? "handoff";
  return {
    ...rest,
    ...(mode === "only" ? { terminalOnly: true } : { terminal: mode === "handoff" }),
    ...(terminal?.via === "link" ? { terminalViaLink: true } : {}),
    ...(terminal?.claims ? { terminalClaims: true } : {}),
    ...(steering ? { steers: true } : {}),
    ...(local?.setup ? { setup: local.setup } : {}),
    ...(local?.commands ? { commands: local.commands } : {}),
    picks: local?.picks?.() ?? [],
    mcpLink: !!local?.mcpLink,
    options: !!options
  };
}
