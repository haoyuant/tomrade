import type { z } from "zod";
import type { PluginContext, ServiceName, ToolSpec } from "./contract.js";

/** Shared by every copy of the SDK, so a plugin that bundled one is still recognised. */
export const SDK_PLUGIN = Symbol.for("tomrade.sdk-plugin");

export interface PluginSpec<C = undefined> {
  /** Loaded when every one is present; unloaded when one goes. */
  inject?: ServiceName[];
  /** Reached through `ctx.when` / `ctx.has`. */
  optional?: ServiceName[];
  /** Validates the row's config before `apply` runs. */
  config?: z.ZodType<C>;
  apply(ctx: PluginContext, config: C): void | Promise<void>;
}

export interface SdkPlugin<C = undefined> extends PluginSpec<C> {
  readonly [SDK_PLUGIN]: 1;
}

export const definePlugin = <C = undefined>(spec: PluginSpec<C>): SdkPlugin<C> => Object.freeze({ ...spec, [SDK_PLUGIN]: 1 as const });

export const isSdkPlugin = (value: unknown): value is SdkPlugin<unknown> =>
  typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SDK_PLUGIN] === 1 && typeof (value as PluginSpec).apply === "function";

export const defineTool = <S extends z.ZodObject>(tool: ToolSpec<S>): ToolSpec<S> => tool;

export class ToolInputError extends Error {
  override name = "ToolInputError";
}

/** Tools scope to the caller's project; without one there is nothing safe to default to. */
export function requireProjectId(tool: string, given: string | undefined, invocation: { projectId?: string }): string {
  const id = given ?? invocation.projectId;
  if (!id) throw new ToolInputError(`${tool}: projectId is required here — call list_projects and pass one`);
  return id;
}
