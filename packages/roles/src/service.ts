import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type {} from "@tomradex/agent";
import { localeOf } from "@tomradex/contracts";
import type {} from "@tomradex/db";
import { languageTag } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/storage";
import { CEILINGS, modeWithin, type Ceiling } from "./permission.js";
import { MIGRATIONS, RoleStore, TABLES, type RoleNeeds, type RoleStage, type StoredRole } from "./store.js";
import { ROLES_WORDS } from "./words.js";

/** The two roles every project has. A person may change them, never remove them. */
export const IMPLEMENTER = "implementer";
export const REVIEWER = "reviewer";
const BUILTIN: Record<string, RoleStage> = { [IMPLEMENTER]: "implement", [REVIEWER]: "review" };

/** A role as a person reads it: one of the project's own, or a built-in one as the project has it. */
export interface Role extends Omit<StoredRole, "updatedAt"> {
  /** One of the two every project has. */
  builtin: boolean;
  /** A built-in one the project has changed: it can be put back. */
  changed: boolean;
  /** Null for a built-in one nobody has changed. */
  updatedAt: number | null;
}

/** What a person saves of a role. Without an id it is a new one. */
export interface RoleInput {
  id?: string;
  title: string;
  stage?: RoleStage;
  engines?: string[];
  permission?: Ceiling | null;
  instructions?: string;
  needs?: RoleNeeds;
}

const PLATFORMS = ["darwin", "win32", "linux"];
const TITLE_MAX = 60;
const INSTRUCTIONS_MAX = 8000;
const ENGINES_MAX = 8;

declare module "cordis" {
  interface Context {
    roles: Roles;
  }
  interface Events {
    "roles/changed"(projectId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "roles.list": (projectId: string) => Role[];
    "roles.save": (projectId: string, input: RoleInput) => Role;
    /** A role of the project's own is removed; a built-in one is put back as it comes. False when there was nothing to do. */
    "roles.remove": (projectId: string, id: string) => boolean;
    /** The permission mode a role's session would start in with this engine; null when the role leaves it to the engine, or the engine has none within the role's limit. */
    "roles.mode": (projectId: string, id: string, engine: string) => string | null;
  }
  interface Broadcasts {
    "roles.changed": (projectId: string) => void;
  }
}

/**
 * A project's roles: named ways of working a ticket that say which agents to try in which order, how far a session may
 * go, and what more its agent is told. A role is no member and holds no machine: every machine of the project reads the
 * same roles and answers them with what it has. Only a person writes them.
 */
export class Roles extends Service {
  static provide = "roles";
  static inject = ["db"];

  private readonly home: Context;
  private readonly store: RoleStore;

  constructor(ctx: Context) {
    super(ctx, "roles");
    this.home = ctx;
    this.store = new RoleStore((projectId) => ctx.db.for(projectId));
  }

  [Service.init]() {
    this.home.db.migrate("roles", MIGRATIONS, { tables: TABLES });
    // Roles another machine wrote arrive with the project's folder.
    this.home.inject(["storage"], (ctx) => {
      ctx.on("storage/imported", (projectId) => ctx.emit("roles/changed", projectId));
    });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("roles.list", (projectId) => ctx.roles.list(projectId));
      ctx.ipc.handle("roles.save", (projectId, input) => ctx.roles.save(projectId, input));
      ctx.ipc.handle("roles.remove", (projectId, id) => ctx.roles.remove(projectId, id));
      ctx.ipc.handle("roles.mode", (projectId, id, engine) => ctx.roles.modeFor(projectId, id, engine));
      ctx.on("roles/changed", (projectId) => ctx.ipc.send("roles.changed", projectId));
    });
  }

  private words() {
    return ROLES_WORDS(languageTag(localeOf(this.home)));
  }

  /** A built-in role as it comes: the reviewer reads and changes nothing, the implementer leaves every choice to Start. */
  private fresh(id: string): Role {
    const stage = BUILTIN[id]!;
    return { id, title: this.words()(id as "implementer" | "reviewer"), stage, engines: [], permission: stage === "review" ? "read" : null, instructions: "", needs: {}, builtin: true, changed: false, updatedAt: null };
  }

  private shown(stored: StoredRole): Role {
    const builtin = stored.id in BUILTIN;
    return { ...stored, builtin, changed: builtin };
  }

  /** The project's roles: the two built-in ones first, then its own by name. */
  list(projectId: string): Role[] {
    if (!this.home.db.has(projectId)) return [];
    const stored = this.store.all(projectId);
    const own = (id: string) => stored.find((role) => role.id === id);
    return [...Object.keys(BUILTIN).map((id) => (own(id) ? this.shown(own(id)!) : this.fresh(id))), ...stored.filter((role) => !(role.id in BUILTIN)).map((role) => this.shown(role))];
  }

  /** Null when the project has no such role. */
  get(projectId: string, id: string): Role | null {
    if (!this.home.db.has(projectId)) return null;
    const stored = this.store.get(projectId, id);
    return stored ? this.shown(stored) : id in BUILTIN ? this.fresh(id) : null;
  }

  /** The role a ticket is worked or reviewed as when none is named, or the named one is gone. */
  orDefault(projectId: string, id: string | null | undefined, stage: RoleStage): Role {
    const asked = id ? this.get(projectId, id) : null;
    return asked?.stage === stage ? asked : (this.get(projectId, stage === "review" ? REVIEWER : IMPLEMENTER) ?? this.fresh(stage === "review" ? REVIEWER : IMPLEMENTER));
  }

  save(projectId: string, input: RoleInput): Role {
    const w = this.words();
    const before = input.id ? this.get(projectId, input.id) : null;
    if (input.id && !before) throw new Error(w("unknownRole", { id: input.id }));
    const title = input.title.trim().slice(0, TITLE_MAX);
    if (!title) throw new Error(w("needsTitle"));
    const id = before?.id ?? randomUUID();
    if (this.list(projectId).some((role) => role.id !== id && role.title.toLowerCase() === title.toLowerCase())) throw new Error(w("titleTaken", { title }));
    const stage = input.stage ?? before?.stage ?? "implement";
    if (stage !== "implement" && stage !== "review") throw new Error("a role implements or reviews");
    if (before?.builtin && stage !== before.stage) throw new Error(w("stageFixed", { title: before.title }));
    const engines = [...new Set((input.engines ?? before?.engines ?? []).map((engine) => engine.trim()).filter(Boolean))].slice(0, ENGINES_MAX);
    // Only its shape is checked: an engine this machine lacks may be one another machine of the project has.
    const strange = engines.find((engine) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(engine));
    if (strange) throw new Error(w("badEngine", { engine: strange }));
    const asked = input.permission === undefined ? (before?.permission ?? null) : input.permission;
    if (asked !== null && !CEILINGS.includes(asked)) throw new Error("a role's limit is read, ask, edits or full");
    // A review changes nothing, whatever is asked for it.
    const permission = stage === "review" ? "read" : asked;
    const needs: RoleNeeds = {};
    const wants = input.needs ?? before?.needs ?? {};
    if (wants.platform && PLATFORMS.includes(wants.platform)) needs.platform = wants.platform;
    if (wants.device?.trim()) needs.device = wants.device.trim().slice(0, 64);
    this.store.put(projectId, { id, title, stage, engines, permission, instructions: (input.instructions ?? before?.instructions ?? "").trim().slice(0, INSTRUCTIONS_MAX), needs, updatedAt: Date.now() });
    this.home.emit("roles/changed", projectId);
    return this.get(projectId, id)!;
  }

  remove(projectId: string, id: string): boolean {
    if (!this.home.db.has(projectId) || !this.store.remove(projectId, id)) return false;
    this.home.emit("roles/changed", projectId);
    return true;
  }

  /**
   * The permission mode a role's session starts in with an engine: the most of the engine's modes within the role's
   * limit. Null when the role sets no limit, the engine has no modes, or none of them is within it.
   */
  modeFor(projectId: string, id: string, engine: string): string | null {
    const role = this.get(projectId, id);
    const modes = this.home.get("agent")?.engineOf(engine)?.permissionModes?.choices.map((choice) => choice.value);
    return role?.permission && modes ? modeWithin(role.permission, modes) : null;
  }
}
