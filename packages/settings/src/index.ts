import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import { englishWords, installWords, isLanguageTag, languageTag, pickLanguage, type AppSettings, type Dictionaries, type LanguageTag } from "@tomradex/domain";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import { agentAccess } from "./agent.js";
import { mapSecrets, mapStrings, SEALED, type SecretCipher } from "./secrets.js";
import { readJsonOr, type SettingsReader, writeJsonAtomic } from "@tomradex/contracts";

export { mapSecrets, SEALED, type SecretCipher } from "./secrets.js";

/**
 * `machine` settings stay on this machine — credentials, paths, binaries.
 * `user` settings are the person's and follow the Hub folder: theme, language,
 * how the assistant is conducted. The safe default is `machine`: a section
 * that forgets to say is one that does not travel, never one that leaks.
 */
export type SettingsScope = "machine" | "user";

/**
 * What an agent may do with a section through get_settings / update_settings.
 * `read` is the default: a setting nobody opened up can be looked at, never
 * changed. A section holding a secret is `none` whatever it declares, and so
 * is anything that runs a command — those are a person's call.
 */
export type SettingsAccess = "write" | "read" | "none";

/** A section's card in one language. Fields left out keep the declaration's words. */
export interface SectionWords {
  title?: string;
  description?: string;
  fields?: Record<string, { title?: string; description?: string; options?: Record<string, string> }>;
}

export interface SettingsSection<T = unknown> {
  id: string;
  title: string;
  description?: string;
  /**
   * Drawn from its JSON Schema. `.meta({ title })` and `.describe()` label a
   * field; `.meta({ advanced: true })` folds it under Advanced in the pane.
   */
  schema: z.ZodType<T>;
  defaults: T;
  /** Lower renders first. Core sections sit below 10. */
  order?: number;
  scope?: SettingsScope;
  agent?: SettingsAccess;
  /**
   * What the card says per language. The declaration's own words are English
   * and are what an agent reads; `en` here only adds what the schema cannot
   * say, such as labels for enum options. Another language falls back to `en`.
   */
  words?: Partial<Record<Locale, SectionWords>>;
  /** Machine-specific choices for fields rendered as selects; validation stays with the schema. */
  choices?: () => Record<string, string[]>;
}

/**
 * What the renderer gets: the schema as JSON Schema, so a card can be drawn
 * without the plugin's code. Option labels ride along as `enumLabels`.
 */
export interface SettingsSectionView {
  id: string;
  title: string;
  description?: string;
  order: number;
  scope: SettingsScope;
  schema: Record<string, unknown>;
}

declare module "cordis" {
  interface Context {
    settings: Settings;
  }
  interface Events {
    "settings/changed"(next: AppSettings, previous: AppSettings): void;
    /** Someone outside the window (a plugin's desktop surface) asked to see this section. */
    "settings/show"(id: string): void;
    /** A language pack came or went. */
    "settings/languages"(): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "settings.get": () => AppSettings;
    "settings.set": (next: AppSettings) => AppSettings;
    "settings.sections": (locale?: Locale) => SettingsSectionView[];
    "settings.secretStorage": () => SecretStorage;
    /** The languages installed packs add, beyond the ones the app ships. */
    "settings.languages": () => LanguageInfo[];
    /** A pack's words for the interface, as it wrote them; the renderer keeps what English has. */
    "settings.languagePack": (tag: string) => { tag: LanguageTag; name: string; ui: Dictionaries } | null;
    /** The interface's English, which the renderer holds: what a pack's coverage is measured against. */
    "settings.uiEnglish": (english: Dictionaries) => void;
  }
  interface Broadcasts {
    /** A language pack came or went. */
    "settings.languagesChanged": () => void;
    /** Changed from somewhere other than this window's own save: an agent, another machine. */
    "settings.changed": (next: AppSettings) => void;
    /** Open Settings on this section. */
    "settings.show": (id: string) => void;
  }
}

export const SettingsConfig = z.object({
  /** The machine file. */
  path: z.string(),
  /** The system's locale, for a language preference of "system". */
  locale: z.string().optional(),
  /** Seals the machine file's secrets. Without one, or while it is unavailable, they stay plain text. */
  cipher: z.custom<SecretCipher>((v) => !!v && typeof (v as SecretCipher).encrypt === "function").optional()
});

/** Where this machine's API keys and tokens rest: encrypted by the OS keychain, or as plain text in settings.json. */
export type SecretStorage = "keychain" | "plaintext";

/** A language tag the app speaks in; a word a language lacks reads English. */
export type Locale = LanguageTag;

/** The languages the app ships; the interface translates them all, the backend writes en and zh. Language packs add more. */
export const LANGUAGES = ["en", "zh", "zh-Hant", "ja", "es", "de", "fr", "ru"] as const;

/** A language a plugin's pack added, with the words it brings. */
export interface InstalledLanguage extends LanguageInfo {
  ui: Dictionaries;
  backend: Dictionaries;
}

/** A language a pack added, as Settings → Language lists it. */
export interface LanguageInfo {
  tag: LanguageTag;
  /** Its name in itself. */
  name: string;
  /** The plugin that added it. */
  plugin: string;
}

/** A language preference made concrete: "system" picks among the languages there are, anything else is the language chosen. */
export const resolveLocale = (preference: string | undefined, system: string | undefined, available: readonly LanguageTag[] = LANGUAGES): Locale =>
  preference && preference !== "system" ? languageTag(preference) : (pickLanguage(system, available) ?? "en");

const isDictionaries = (v: unknown): v is Dictionaries =>
  isRecord(v) && Object.values(v).every((ns) => isRecord(ns) && Object.values(ns).every((t) => typeof t === "string"));
export type SettingsConfig = z.infer<typeof SettingsConfig>;

/** The Hub's settings file: user-scope sections, each stamped so two machines can settle a clash by time. */
export const USER_SETTINGS_FILE = "settings.json";

export interface UserSettingsFile {
  v: 1;
  sections: Record<string, { value: unknown; updatedAt: number }>;
}

export interface UserSettingsStore {
  read(): UserSettingsFile;
  write(file: UserSettingsFile): void;
}

const THEME: SettingsSection<AppSettings["theme"]> = {
  id: "theme",
  title: "Appearance",
  schema: z.string().refine(v => ["system", "light", "dark", "matcha", "dawn"].includes(v) || /^custom:[a-z0-9-]+$/.test(v)).describe('"system", "light", "dark", "matcha", "dawn", or a custom theme\'s id ("custom:…").') as z.ZodType<AppSettings["theme"]>,
  defaults: "dawn",
  order: 0,
  scope: "user",
  agent: "write"
};

const LANGUAGE: SettingsSection<AppSettings["language"]> = {
  id: "language",
  title: "Language",
  schema: z
    .string()
    .refine((v) => v === "system" || isLanguageTag(v), "\"system\" or a language tag")
    .describe(`"system", or a language tag: ${LANGUAGES.map((l) => `"${l}"`).join(", ")}, or one an installed language pack adds.`),
  defaults: "system",
  order: 1,
  scope: "user",
  agent: "write"
};

const CSS_VALUE = z.string().min(1).max(256).refine(v => !/[{};]/.test(v), "Invalid CSS token value");
const THEME_TOKEN_KEYS = ["bg", "surface", "surface-warm", "fg", "fg-2", "muted", "meta", "border", "border-soft", "accent", "accent-on", "accent-light", "accent-active", "success", "warn", "danger", "tag-bg-faint", "tag-bg-soft", "tag-bg-base", "tag-bg-strong", "tag-fg"] as const;
const THEME_FONT_KEYS = ["font-display", "font-body", "font-mono", "text-xs", "text-sm", "text-base", "text-md", "text-lg", "text-xl", "text-2xl", "font-weight-regular", "font-weight-medium"] as const;
const valuesOf = <T extends readonly string[]>(keys: T) => z.object(Object.fromEntries(keys.map(key => [key, CSS_VALUE])) as Record<T[number], typeof CSS_VALUE>);
const CUSTOM_THEMES: SettingsSection<unknown[]> = {
  id: "customThemes", title: "Custom themes", description: "Hub-synchronized custom colours and fonts.",
  schema: z.array(z.object({
    id: z.string().regex(/^custom:[a-z0-9-]+$/), name: z.string().trim().min(1).max(64),
    base: z.enum(["light", "dark", "matcha", "dawn"]), icon: z.enum(["i-sun", "i-moon", "i-leaf", "i-tag", "i-bug", "i-board", "i-stack", "i-sliders"]).default("i-sliders"), tokens: valuesOf(THEME_TOKEN_KEYS), fonts: valuesOf(THEME_FONT_KEYS).partial()
  })).max(32),
  defaults: [], order: 0.5, scope: "user", agent: "write"
};
const THEME_AUTOMATION: SettingsSection<unknown> = {
  id: "themeAutomation", title: "Theme automation", description: "Automatic theme switching.", scope: "user", order: 0.25, agent: "write",
  schema: z.object({
    mode: z.enum(["none", "system", "schedule", "shuffle"]),
    defaultTheme: z.string().refine(v => ["light", "dark", "matcha", "dawn"].includes(v) || /^custom:[a-z0-9-]+$/.test(v)),
    schedule: z.array(z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("23:59"), theme: z.string().refine(v => ["light", "dark", "matcha", "dawn"].includes(v) || /^custom:[a-z0-9-]+$/.test(v)) }).refine(rule => rule.start !== rule.end, "A time range needs different start and end times.")).max(24),
    shuffleMinutes: z.number().int().min(1).max(10080)
  }),
  defaults: { mode: "none", defaultTheme: "dawn", schedule: [], shuffleMinutes: 60 }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A refused value names the field and why, rather than a dump of every issue. */
function parseSection<T>(section: SettingsSection<T>, value: unknown): T {
  const parsed = section.schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new Error(`${[section.id, ...issue.path].join(".")}: ${issue.message}`);
}

function cardOf(section: SettingsSection, scope: SettingsScope, locale: Locale, stored?: unknown): SettingsSectionView {
  const schema = z.toJSONSchema(section.schema) as Record<string, unknown>;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, choices] of Object.entries(section.choices?.() ?? {})) {
    const property = properties[name];
    if (!isRecord(property)) continue;
    const saved = isRecord(stored) ? stored[name] : undefined;
    const current = typeof saved === "string" ? saved : isRecord(section.defaults) ? section.defaults[name] : undefined;
    property.enum = typeof current === "string" && !choices.includes(current) ? [...choices, current] : choices;
  }
  let title = section.title;
  let description = section.description;
  for (const words of locale === "en" ? [section.words?.en] : [section.words?.en, section.words?.[locale]]) {
    if (!words) continue;
    title = words.title ?? title;
    description = words.description ?? description;
    for (const [name, field] of Object.entries(words.fields ?? {})) {
      const property = properties[name];
      if (!isRecord(property)) continue;
      if (field.title) property.title = field.title;
      if (field.description) property.description = field.description;
      if (field.options) property.enumLabels = { ...(isRecord(property.enumLabels) ? property.enumLabels : {}), ...field.options };
    }
  }
  return { id: section.id, title, description, order: section.order ?? 100, scope, schema };
}

/** Every read of settings asks this of every section, and a schema never changes once made. */
const secretSchemas = new WeakMap<z.ZodType, boolean>();

/** A section whose schema names a password never leaves the machine, whatever it declares. */
function holdsSecret(schema: z.ZodType): boolean {
  const known = secretSchemas.get(schema);
  if (known !== undefined) return known;
  const visit = (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    if (isRecord(v) && v.format === "password") return true;
    return Object.values(v).some(visit);
  };
  const secret = visit(z.toJSONSchema(schema));
  secretSchemas.set(schema, secret);
  return secret;
}

export class Settings extends Service implements SettingsReader {
  static provide = "settings";
  static Config = SettingsConfig;

  private registry = new Map<string, SettingsSection>();
  private stored: Record<string, unknown> = {};
  private user: UserSettingsFile = { v: 1, sections: {} };
  private userFile: string | null = null;
  private userStore: UserSettingsStore | null = null;
  /** Sealed values this run couldn't open, by where they sit: written back as they were until that field is set again. */
  private unopened = new Map<string, string>();
  private packs = new Map<LanguageTag, InstalledLanguage>();
  private uiEnglish: Dictionaries | null = null;

  /** Only registered, validated user sections may cross the cloud boundary. */
  exportUser(): UserSettingsFile {
    const sections: UserSettingsFile["sections"] = {};
    for (const s of this.registry.values()) {
      if (this.scopeOf(s) !== "user") continue;
      const entry = this.user.sections[s.id];
      if (!entry) continue;
      const parsed = s.schema.safeParse(entry.value);
      if (parsed.success) sections[s.id] = { value: parsed.data, updatedAt: entry.updatedAt };
    }
    return { v: 1, sections };
  }

  useUserStore(store: UserSettingsStore): () => void {
    if (this.userStore) throw new Error("A user settings store is already installed");
    this.userStore = store;
    return () => { this.userStore = null; };
  }

  /** A cloud revision is authoritative, independently of device clock skew. */
  refreshUserStore(): void {
    if (!this.userStore) return;
    const before = this.get();
    for (const [id, entry] of Object.entries(this.userStore.read().sections)) {
      const section = this.registry.get(id);
      if (!section || this.scopeOf(section) !== "user") continue;
      const parsed = section.schema.safeParse(entry.value);
      if (parsed.success) this.user.sections[id] = { value: parsed.data, updatedAt: entry.updatedAt };
    }
    const after = this.get();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.home.emit("settings/changed", after, before);
  }
  private readonly home: Context;

  constructor(
    ctx: Context,
    public readonly config: SettingsConfig
  ) {
    super(ctx, "settings");
    this.home = ctx;
  }

  [Service.init]() {
    const raw = readJsonOr<unknown>(this.config.path, undefined);
    if (isRecord(raw)) this.stored = this.open(raw);
    this.register(THEME);
    this.register(THEME_AUTOMATION);
    this.register(CUSTOM_THEMES);
    this.register(LANGUAGE);
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("settings.get", () => ctx.settings.get());
      // What listeners settled on (e.g. a removed profile's picks dropped), not what was sent.
      ctx.ipc.handle("settings.set", (next) => (ctx.settings.set(next), ctx.settings.get()));
      ctx.ipc.handle("settings.sections", (locale) => ctx.settings.sections(isLanguageTag(locale) ? languageTag(locale) : undefined));
      ctx.ipc.handle("settings.secretStorage", () => ctx.settings.secretStorage());
      ctx.ipc.handle("settings.languages", () => ctx.settings.languages());
      ctx.ipc.handle("settings.languagePack", (tag) => ctx.settings.languagePack(tag));
      ctx.ipc.handle("settings.uiEnglish", (english) => ctx.settings.useUiEnglish(english));
      ctx.on("settings/changed", (next) => ctx.ipc.send("settings.changed", next));
      ctx.on("settings/show", (id) => ctx.ipc.send("settings.show", id));
      ctx.on("settings/languages", () => ctx.ipc.send("settings.languagesChanged"));
    });
    this.home.inject(["tools", "db", "oplog", "hub"], (ctx) => agentAccess(ctx));
    // User-scope sections follow the Hub folder once there is one.
    this.home.inject(["hub"], (ctx) => {
      const attach = (dir: string | null) => {
        this.userFile = dir ? path.join(dir, USER_SETTINGS_FILE) : null;
        if (this.userStore) this.refreshUserStore();
        else this.loadUser();
      };
      attach(ctx.hub.dir);
      const off = ctx.on("hub/configured", (dir) => {
        const before = this.get();
        attach(dir);
        // Whatever this machine had chosen travels along when the Hub is first set up.
        if (!Object.keys(this.user.sections).length) this.persistUser();
        this.home.emit("settings/changed", this.get(), before);
      });
      return () => {
        off();
        this.userFile = null;
        this.user = { v: 1, sections: {} };
      };
    });
  }

  scopeOf(section: SettingsSection): SettingsScope {
    return section.scope === "user" && !holdsSecret(section.schema) ? "user" : "machine";
  }

  accessOf(section: SettingsSection): SettingsAccess {
    return holdsSecret(section.schema) ? "none" : section.agent ?? "read";
  }

  section(id: string): SettingsSection | undefined {
    return this.registry.get(id);
  }

  /** Reversible: the section and its card disappear with the plugin that registered them. */
  register<T>(section: SettingsSection<T>): () => void {
    if (this.registry.has(section.id)) throw new Error(`settings section "${section.id}" is already registered`);
    return this.ctx.effect(() => {
      this.registry.set(section.id, section as SettingsSection);
      return () => this.registry.delete(section.id);
    }, `settings.register(${section.id})`);
  }

  /** The cards, in the renderer's language when it says, else the person's. */
  sections(locale: Locale = this.locale()): SettingsSectionView[] {
    return [...this.registry.values()]
      .map((s) => cardOf(s, this.scopeOf(s), locale, this.storedValue(s)))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  private storedValue(section: SettingsSection): unknown {
    if ((this.userFile || this.userStore) && this.scopeOf(section) === "user") {
      const entry = this.user.sections[section.id];
      if (entry) return entry.value;
    }
    return this.stored[section.id];
  }

  /** Registered sections come back complete: defaults filled in under whatever was stored. */
  /** The language to speak to the person in — for words the backend writes, which the renderer shows as they are. */
  locale(): Locale {
    return resolveLocale(this.get().language as string | undefined, this.config.locale, [...LANGUAGES, ...this.packs.keys()]);
  }

  /**
   * A plugin's language, for as long as the plugin runs: Settings → Language
   * lists it, "system" picks it when the system prefers it, and the backend's
   * books and the interface speak it, English wherever it is silent. One pack
   * per language: a second is set aside with a warning.
   */
  addLanguage(pack: InstalledLanguage): () => void {
    return this.ctx.effect(() => {
      if (this.packs.has(pack.tag)) {
        this.home.logger.warn(`${pack.plugin}: ${this.packs.get(pack.tag)!.plugin} already adds the language "${pack.tag}"; this one is not used`);
        return () => {};
      }
      this.packs.set(pack.tag, pack);
      const unspeak = installWords(pack.tag, pack.backend);
      this.home.emit("settings/languages");
      return () => {
        unspeak();
        this.packs.delete(pack.tag);
        this.home.emit("settings/languages");
      };
    }, `settings.addLanguage(${pack.tag})`);
  }

  languages(): LanguageInfo[] {
    return [...this.packs.values()].map(({ tag, name, plugin }) => ({ tag, name, plugin }));
  }

  languagePack(tag: string): { tag: LanguageTag; name: string; ui: Dictionaries } | null {
    const pack = this.packs.get(languageTag(tag));
    return pack ? { tag: pack.tag, name: pack.name, ui: pack.ui } : null;
  }

  /** What a language pack translates: the backend's books, and the interface's dictionaries once a window has said what they are. */
  english(): { ui: Dictionaries | null; backend: Dictionaries } {
    return { ui: this.uiEnglish, backend: englishWords() };
  }

  useUiEnglish(english: unknown): void {
    if (isDictionaries(english)) this.uiEnglish = english;
  }

  /** Asks the app window to open Settings on a registered section; the shell brings the window forward. */
  show(id: string): void {
    if (!this.registry.has(id)) throw new Error(`settings section "${id}" is not registered`);
    this.home.emit("settings/show", id);
  }

  get(): AppSettings {
    const out: Record<string, unknown> = { ...this.stored };
    for (const s of this.registry.values()) {
      const stored = this.storedValue(s);
      out[s.id] = isRecord(s.defaults) && isRecord(stored) ? { ...s.defaults, ...stored } : (stored ?? s.defaults);
    }
    return out as AppSettings;
  }

  set(next: AppSettings): AppSettings {
    const previous = this.get();
    const stored = { ...this.stored };
    const now = Date.now();
    let userTouched = false;
    for (const [id, value] of Object.entries(next)) {
      const section = this.registry.get(id);
      const parsed = section ? parseSection(section, value) : value;
      if (section && (this.userFile || this.userStore) && this.scopeOf(section) === "user") {
        if (JSON.stringify(this.user.sections[id]?.value) !== JSON.stringify(parsed)) {
          this.user.sections[id] = { value: parsed, updatedAt: now };
          userTouched = true;
        }
        // The machine file keeps a copy, so a Hub that is moved away leaves nothing behind.
        stored[id] = parsed;
      } else {
        stored[id] = parsed;
      }
    }
    this.stored = stored;
    this.persistMachine();
    if (userTouched) this.persistUser();
    const current = this.get();
    this.home.emit("settings/changed", current, previous);
    return current;
  }

  secretStorage(): SecretStorage {
    return this.config.cipher?.available() ? "keychain" : "plaintext";
  }

  /** The machine file as stored, opened: sealed values decrypted, and plain ones sealed straight away when they can be. */
  private open(raw: Record<string, unknown>): Record<string, unknown> {
    const cipher = this.secretStorage() === "keychain" ? this.config.cipher! : null;
    const opened = mapStrings(raw, (text, at) => {
      if (!text.startsWith(SEALED)) return text;
      try {
        if (cipher) return cipher.decrypt(Buffer.from(text.slice(SEALED.length), "base64"));
      } catch {
        // a reset or different keychain: the value is lost to this machine, but not overwritten
      }
      this.unopened.set(at, text);
      return "";
    }) as Record<string, unknown>;
    if (this.unopened.size) this.home.logger.warn(`${this.unopened.size} saved key(s) or token(s) in ${this.config.path} can't be decrypted on this system; enter them again`);
    let plain = false;
    mapSecrets(opened, (secret) => (plain ||= secret !== ""));
    try {
      if (cipher && plain) writeJsonAtomic(this.config.path, this.sealed(opened, cipher), { mode: 0o600 });
      else if (fs.statSync(this.config.path).mode & 0o077) fs.chmodSync(this.config.path, 0o600);
    } catch (e) {
      this.home.logger.warn(`couldn't secure ${this.config.path}: ${(e as Error).message}`);
    }
    return opened;
  }

  private sealed(value: Record<string, unknown>, cipher: SecretCipher | null): unknown {
    return mapSecrets(value, (secret, at) => {
      if (!secret) return this.unopened.get(at) ?? secret;
      this.unopened.delete(at);
      return cipher ? SEALED + cipher.encrypt(secret).toString("base64") : secret;
    });
  }

  private persistMachine(): void {
    writeJsonAtomic(this.config.path, this.sealed(this.stored, this.secretStorage() === "keychain" ? this.config.cipher! : null), { mode: 0o600 });
  }

  /** The user-scope file as another machine may have written it, folded in: the later stamp wins per section. */
  mergeUser(theirs: unknown): void {
    if (!isRecord(theirs) || !isRecord(theirs.sections)) return;
    let changed = false;
    for (const [id, entry] of Object.entries(theirs.sections)) {
      if (!isRecord(entry) || typeof entry.updatedAt !== "number") continue;
      const mine = this.user.sections[id];
      if (!mine || entry.updatedAt > mine.updatedAt) {
        this.user.sections[id] = { value: entry.value, updatedAt: entry.updatedAt };
        changed = true;
      }
    }
    if (changed) {
      this.persistUser();
      this.home.emit("settings/changed", this.get(), this.get());
    }
  }

  private loadUser(): void {
    this.user = { v: 1, sections: {} };
    if (!this.userFile) return;
    const raw = readJsonOr<unknown>(this.userFile, undefined);
    if (isRecord(raw) && isRecord(raw.sections)) {
      for (const [id, entry] of Object.entries(raw.sections)) {
        if (isRecord(entry) && typeof entry.updatedAt === "number") this.user.sections[id] = { value: entry.value, updatedAt: entry.updatedAt };
      }
    }
  }

  private persistUser(): void {
    if (this.userStore) { this.userStore.write(this.exportUser()); return; }
    if (!this.userFile) return;
    // Seed from the machine file the first time, so a fresh Hub starts with what the person already chose.
    for (const s of this.registry.values()) {
      if (this.scopeOf(s) !== "user" || this.user.sections[s.id] || this.stored[s.id] === undefined) continue;
      this.user.sections[s.id] = { value: this.stored[s.id], updatedAt: Date.now() };
    }
    writeJsonAtomic(this.userFile, this.user);
  }
}

export default Settings;
