import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentOptions, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import type { RegistryAgent } from "./registry.js";

/**
 * What an added agent keeps in settings: enough of its manifest to register it
 * on every launch without the registry — offline included.
 */
export const AddedAgent = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default(""),
  description: z.string().default(""),
  license: z.string().optional(),
  repository: z.string().optional(),
  package: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({})
});
export type AddedAgent = z.infer<typeof AddedAgent>;

export const addedOf = (agent: RegistryAgent): AddedAgent => {
  const npx = agent.distribution.npx!;
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    description: agent.description,
    ...(agent.license ? { license: agent.license } : {}),
    ...(agent.repository ? { repository: agent.repository } : {}),
    package: npx.package,
    args: npx.args,
    env: npx.env
  };
};

const options: z.ZodType<LocalAgentOptions> = z.object({
  command: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional()
});

/**
 * A registry manifest as a local-agent spec, the same shape a plugin would
 * declare: launched over ACP through `npx` (unpinned, so a global install
 * decides the version), installed with `npm install -g`, signed in the way the
 * agent itself asks — the registry only lists agents that support that.
 */
export function specOf(added: AddedAgent): LocalAgentSpec {
  return {
    id: `registry:${added.id}`,
    title: added.name,
    cli: { name: "npx" },
    install: "it runs through npx, which installing Node.js provides — {install}",
    setup: {
      // The installer, not a bare command: the one-click chain runs it through the system's npm or Tomrade's bundled one (TOM-507).
      install: [{ npm: added.package }],
      ...(added.repository ? { docs: added.repository } : {}),
      download: "https://nodejs.org/en/download"
    },
    signIn: `run \`npx ${added.package}\` in a terminal and sign in there`,
    options,
    acp: {
      permissionModes: { default: "ask", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
      args: () => ["--yes", added.package, ...added.args],
      ...(Object.keys(added.env).length ? { env: () => ({ ...added.env }) } : {})
    }
  };
}
