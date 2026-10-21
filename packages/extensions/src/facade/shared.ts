import type { Host } from "../host.js";

/** What every API module is built from: the plugin's host, its namespace, and the logger its context was built with. */
export interface Facade {
  host: Host;
  ns: string;
  logger: Host["logger"];
}

export type Fn = (...args: never[]) => unknown;

/** A render callback has this long before its contribution is dropped for the refresh. */
export const RENDER_MS = 2_000;
export const COMMAND_MS = 60_000;
/** A hook in the agent's loop has this long before the step goes on without it. */
export const HOOK_MS = 10_000;
/** A CLI agent waits five seconds for Tomrade's answer to its hook; a plugin's comes inside that, or not at all. */
export const CLI_HOOK_MS = 3_000;

/** What a policy is shown: its own copy where the value allows one, so a change of its reaches nothing. */
export const copy = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};
