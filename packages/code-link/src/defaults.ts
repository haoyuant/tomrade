import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { StartMode } from "./start.js";

/**
 * What the Start dialog last ran a ticket with: which surface, which agent and
 * the knobs picked there. It is a preference, not evidence — it rests in a
 * machine-local file beside the settings file, never the backlog and never the
 * Hub, since the agents it names are installed on this machine or nowhere.
 *
 * Read leniently: anything the person has since removed (an agent uninstalled,
 * a model or permission mode that is gone) is dropped field by field and the
 * dialog falls back to its own default, rather than the file failing to load.
 */
const StartDefaults = z.object({
  mode: z.enum(["run", "terminal"]),
  /** An engine id, or "other" for the terminal command template. */
  engine: z.string().min(1).optional(),
  /** Engine option overrides (model, effort…), as the Start dialog sent them. */
  options: z.record(z.string(), z.unknown()).optional(),
  /** Headless runs only: the permission mode. */
  permissionMode: z.string().min(1).optional(),
  /** General tickets only: the delivery method. */
  playbook: z.string().min(1).optional(),
  updatedAt: z.number()
});

/** The remembered configuration, as the Start dialog reads it. */
export type StartDefaultsView = Omit<z.infer<typeof StartDefaults>, "updatedAt">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The knobs this version still understands; an option a person typed empty is not a choice worth carrying. */
function usableOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) if (typeof value === "string" && value) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

export class StartDefaultsStore {
  constructor(private readonly file: string | null) {}

  /** The remembered configuration, or null when there is none (or nothing usable is left of it). */
  read(): StartDefaultsView | null {
    if (!this.file) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
    if (!isRecord(raw)) return null;
    // Field by field: one value that has gone is not the whole memory.
    const mode = raw.mode === "run" || raw.mode === "terminal" ? raw.mode : null;
    if (!mode) return null;
    const engine = typeof raw.engine === "string" && raw.engine.trim() ? raw.engine.trim() : undefined;
    const permissionMode = typeof raw.permissionMode === "string" && raw.permissionMode.trim() ? raw.permissionMode.trim() : undefined;
    const playbook = typeof raw.playbook === "string" && raw.playbook.trim() ? raw.playbook.trim() : undefined;
    const options = isRecord(raw.options) ? usableOptions(raw.options) : undefined;
    // Nothing but the surface is not a memory: the dialog's own defaults say as much.
    if (!engine && !permissionMode && !playbook && !options) return null;
    return { mode, ...(engine ? { engine } : {}), ...(options ? { options } : {}), ...(permissionMode ? { permissionMode } : {}), ...(playbook ? { playbook } : {}) };
  }

  /** Remember what a start used. Best-effort: a failure to write is not a failure to start. */
  write(memory: { mode: StartMode; engine?: string; options?: Record<string, unknown>; permissionMode?: string; playbook?: string }): void {
    if (!this.file) return;
    const options = usableOptions(memory.options);
    const next = {
      mode: memory.mode,
      ...(memory.engine ? { engine: memory.engine } : {}),
      ...(options ? { options } : {}),
      ...(memory.permissionMode ? { permissionMode: memory.permissionMode } : {}),
      ...(memory.playbook ? { playbook: memory.playbook } : {}),
      updatedAt: Date.now()
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // The next start simply falls back to the dialog's own defaults.
    }
  }
}
