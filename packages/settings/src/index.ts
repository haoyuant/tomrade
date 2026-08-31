import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { AppSettings } from "@tomrade/domain";
import type {} from "@tomrade/ipc";

export interface SettingsSection<T = unknown> {
  id: string;
  title: string;
  description?: string;
  schema: z.ZodType<T>;
  defaults: T;
  /** Lower renders first. Core sections sit below 10. */
  order?: number;
}

/** What the renderer gets: the schema as JSON Schema, so a card can be drawn without the plugin's code. */
export interface SettingsSectionView {
  id: string;
  title: string;
  description?: string;
  order: number;
  schema: Record<string, unknown>;
}

declare module "cordis" {
  interface Context {
    settings: Settings;
  }
  interface Events {
    "settings/changed"(next: AppSettings, previous: AppSettings): void;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "settings.get": () => AppSettings;
    "settings.set": (next: AppSettings) => AppSettings;
    "settings.sections": () => SettingsSectionView[];
  }
}

export const SettingsConfig = z.object({ path: z.string() });
export type SettingsConfig = z.infer<typeof SettingsConfig>;

const THEME: SettingsSection<AppSettings["theme"]> = {
  id: "theme",
  title: "Appearance",
  schema: z.enum(["system", "light", "dark", "matcha"]),
  defaults: "system",
  order: 0
};

const LANGUAGE: SettingsSection<AppSettings["language"]> = {
  id: "language",
  title: "Language",
  schema: z.enum(["system", "en", "zh"]),
  defaults: "system",
  order: 1
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Settings extends Service {
  static provide = "settings";
  static Config = SettingsConfig;

  private registry = new Map<string, SettingsSection>();
  private stored: Record<string, unknown> = {};

  constructor(
    ctx: Context,
    public readonly config: SettingsConfig
  ) {
    super(ctx, "settings");
  }

  [Service.init]() {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.config.path, "utf8"));
      if (isRecord(raw)) this.stored = raw;
    } catch {
      // first run
    }
    this.register(THEME);
    this.register(LANGUAGE);
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("settings.get", () => ctx.settings.get());
      ctx.ipc.handle("settings.set", (next) => ctx.settings.set(next));
      ctx.ipc.handle("settings.sections", () => ctx.settings.sections());
    });
  }

  /** Reversible: the section and its card disappear with the plugin that registered them. */
  register<T>(section: SettingsSection<T>): () => void {
    if (this.registry.has(section.id)) throw new Error(`settings section "${section.id}" is already registered`);
    return this.ctx.effect(() => {
      this.registry.set(section.id, section as SettingsSection);
      return () => this.registry.delete(section.id);
    }, `settings.register(${section.id})`);
  }

  sections(): SettingsSectionView[] {
    return [...this.registry.values()]
      .map((s) => ({ id: s.id, title: s.title, description: s.description, order: s.order ?? 100, schema: z.toJSONSchema(s.schema) as Record<string, unknown> }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  /** Registered sections come back complete: defaults filled in under whatever was stored. */
  get(): AppSettings {
    const out: Record<string, unknown> = { ...this.stored };
    for (const s of this.registry.values()) {
      const stored = this.stored[s.id];
      out[s.id] = isRecord(s.defaults) && isRecord(stored) ? { ...s.defaults, ...stored } : (stored ?? s.defaults);
    }
    return out as AppSettings;
  }

  set(next: AppSettings): AppSettings {
    const previous = this.get();
    const stored = { ...this.stored };
    for (const [id, value] of Object.entries(next)) {
      const section = this.registry.get(id);
      stored[id] = section ? section.schema.parse(value) : value;
    }
    this.stored = stored;
    fs.mkdirSync(path.dirname(this.config.path), { recursive: true });
    fs.writeFileSync(this.config.path, JSON.stringify(stored, null, 2), "utf8");
    const current = this.get();
    this.ctx.emit("settings/changed", current, previous);
    return current;
  }
}

export default Settings;
