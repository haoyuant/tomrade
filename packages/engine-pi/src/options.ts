import { z } from "zod";
import type { TurnInput } from "@tomradex/agent";

export const PiOptions = z.object({
  command: z.string().default("pi"),
  /** `--model`: an id or `provider/id`; empty keeps pi's own default. */
  model: z.string().optional(),
  /** `--thinking`; pi clamps it to what the model supports. */
  effort: z.string().optional()
});
export type PiOptions = z.infer<typeof PiOptions>;

export const PERMISSION_MODES = {
  default: "full-access",
  // Pi has no permissions of its own; in the main chat Tomrade asks before anything changes.
  mainDefault: "ask",
  choices: [
    { value: "full-access", label: "Full access" },
    { value: "ask", label: "Ask permissions" },
    { value: "read-only", label: "Read only" }
  ]
};

/** The `--tools` allowlist for a turn, or null for pi's own selection; read-only keeps the built-ins that look. */
export function toolSelection(input: Pick<TurnInput, "permissionMode">): string | null {
  return input.permissionMode === "read-only" ? "read,grep,find,ls,mcp__tomrade__*" : null;
}

const MODEL_TABLE = /^\s*provider\s+model\b/;

/** `pi --list-models` says "No models available" until a provider has a credential. */
export function piSignedIn(output: string): boolean | null {
  if (/no models available/i.test(output)) return false;
  return output.split("\n").some((line) => MODEL_TABLE.test(line)) ? true : null;
}

/** The `provider/model` ids from `pi --list-models`' table. */
export function listedModels(output: string): string[] {
  const lines = output.split("\n");
  const header = lines.findIndex((line) => MODEL_TABLE.test(line));
  if (header < 0) return [];
  return lines.slice(header + 1).map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 2 && cells[0]).map(([provider, model]) => `${provider}/${model}`);
}
