import { Context, Service, type Plugin } from "cordis";
import { beforeEach, describe, expect, it } from "vitest";
import { Plugins, RequiredModuleError, type ModuleSpec, type PluginRow } from "@tomrade/plugins";

/** Nested fibers activate a microtask after their dependencies; this lets them. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

declare module "cordis" {
  interface Context {
    store: Store;
    ledger: Ledger;
    notes: Notes;
    reader: Reader;
  }
}

class Store extends Service {
  static provide = "store";
  constructor(ctx: Context) {
    super(ctx, "store");
  }
}

class Ledger extends Service {
  static provide = "ledger";
  static inject = ["store"];
  constructor(ctx: Context) {
    super(ctx, "ledger");
  }
}

class Notes extends Service {
  static provide = "notes";
  constructor(ctx: Context) {
    super(ctx, "notes");
  }
}

class Reader extends Service {
  static provide = "reader";
  static inject = ["notes"];
  constructor(ctx: Context) {
    super(ctx, "reader");
  }
}

/** One row, two service keys, reached through a nested plugin — the shape @tomrade/boards has. */
const pair = {
  name: "pair",
  async apply(ctx: Context) {
    await ctx.plugin(Notes);
    await ctx.plugin(Reader);
  }
};

/** Provides nothing and is nobody's dependency: the third-party case. */
const bystander = {
  name: "bystander",
  inject: ["store"],
  apply() {}
};

const MODULES: ModuleSpec[] = [
  { id: "store", title: "Storage", required: true },
  { id: "ledger", title: "Ledger", required: true },
  { id: "notes", title: "Notes" },
  { id: "reader", title: "Reader" }
];

const CATALOGUE: Record<string, Plugin> = { store: Store, ledger: Ledger, pair, bystander };

interface Harness {
  ctx: Context;
  rows: PluginRow[];
  persisted: [string, boolean][];
  failures: unknown[];
}

async function boot(rows: PluginRow[], modules: ModuleSpec[] = MODULES): Promise<Harness> {
  const ctx = new Context();
  const failures: unknown[] = [];
  ctx.logger.exporter({
    export: (m) => {
      if (m.type === "error") failures.push(m.args[0]);
    }
  });
  const persisted: [string, boolean][] = [];
  await ctx.plugin(Plugins, {
    rows,
    modules,
    resolve: async (name) => {
      const plugin = CATALOGUE[name];
      if (!plugin) throw new Error(`Cannot find package '${name}'`);
      return plugin;
    },
    persist: (id, disabled) => void persisted.push([id, disabled])
  });
  await settle();
  return { ctx, rows, persisted, failures };
}

const ROWS = (): PluginRow[] => [
  { id: "store", name: "store" },
  { id: "ledger", name: "ledger" },
  { id: "pair", name: "pair" },
  { id: "bystander", name: "bystander" }
];

const viewOf = (h: Harness, id: string) => h.ctx.plugins.list().find((p) => p.id === id)!;
const moduleOf = (h: Harness, id: string) => h.ctx.plugins.modules().find((m) => m.id === id)!;

describe("the composition it booted", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot(ROWS());
  });

  it("reports every row as active, with no failure logged", () => {
    expect(h.failures).toEqual([]);
    expect(h.ctx.plugins.list().map((p) => [p.id, p.state])).toEqual([
      ["store", "active"],
      ["ledger", "active"],
      ["pair", "active"],
      ["bystander", "active"]
    ]);
  });

  it("credits a row with what its nested plugins provide", () => {
    expect(viewOf(h, "pair").provides.sort()).toEqual(["notes", "reader"]);
    expect(moduleOf(h, "notes").providers).toEqual(["pair"]);
    expect(moduleOf(h, "reader").providers).toEqual(["pair"]);
  });

  it("reads what a row needs off its fiber", () => {
    expect(viewOf(h, "ledger").injects).toEqual(["store"]);
    expect(viewOf(h, "store").injects).toEqual([]);
  });

  it("marks the row holding up a required module on its own", () => {
    expect(viewOf(h, "store").holds).toEqual(["store"]);
    expect(viewOf(h, "ledger").holds).toEqual(["ledger"]);
    // Nobody else provides them, but neither module is required.
    expect(viewOf(h, "pair").holds).toEqual([]);
  });
});

describe("switching a row off", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot(ROWS());
  });

  it("unloads it, records the choice, and leaves the rest running", async () => {
    await h.ctx.plugins.setEnabled("bystander", false);
    expect(viewOf(h, "bystander").state).toBe("disabled");
    expect(h.persisted).toEqual([["bystander", true]]);
    expect(h.ctx.get("store")).toBeDefined();
  });

  it("takes what depended on it with it", async () => {
    await h.ctx.plugins.setEnabled("pair", false);
    await settle();
    expect(h.ctx.get("notes")).toBeUndefined();
    expect(h.ctx.get("reader")).toBeUndefined();
    expect(moduleOf(h, "notes").providers).toEqual([]);
  });

  it("is refused when it is the only plugin providing a required module", async () => {
    await expect(h.ctx.plugins.setEnabled("ledger", false)).rejects.toThrow(RequiredModuleError);
    await expect(h.ctx.plugins.setEnabled("ledger", false)).rejects.toThrow(/would leave Ledger with no plugin/);
    expect(viewOf(h, "ledger").state).toBe("active");
    expect(h.persisted).toEqual([]);
  });

  it("is refused when the cascade would empty a required module, and puts the row back", async () => {
    // `store` is required and provided by `store`; `ledger` is required and
    // injects it, so switching `store` off would empty Ledger too. The cheap
    // check catches Storage first — either way nothing may come down.
    await expect(h.ctx.plugins.setEnabled("store", false)).rejects.toThrow(RequiredModuleError);
    expect(h.ctx.get("store")).toBeDefined();
    expect(h.ctx.get("ledger")).toBeDefined();
    expect(viewOf(h, "store").state).toBe("active");
    expect(h.persisted).toEqual([]);
  });

  it("switching it back on restores it and everything that fell with it", async () => {
    await h.ctx.plugins.setEnabled("pair", false);
    await h.ctx.plugins.setEnabled("pair", true);
    await settle();
    expect(viewOf(h, "pair").state).toBe("active");
    expect(h.ctx.get("notes")).toBeDefined();
    expect(moduleOf(h, "reader").providers).toEqual(["pair"]);
    expect(h.persisted).toEqual([
      ["pair", true],
      ["pair", false]
    ]);
  });

  it("says so for a row that is not in the composition", async () => {
    await expect(h.ctx.plugins.setEnabled("nope", false)).rejects.toThrow(/Unknown plugin/);
  });

  it("runs switches one at a time, and a refused one does not take the next with it", async () => {
    const [off, refused, on] = await Promise.allSettled([
      h.ctx.plugins.setEnabled("pair", false),
      h.ctx.plugins.setEnabled("ledger", false),
      h.ctx.plugins.setEnabled("pair", true)
    ]);
    expect(off.status).toBe("fulfilled");
    expect(refused.status).toBe("rejected");
    expect(on.status).toBe("fulfilled");
    await settle();
    expect(viewOf(h, "pair").state).toBe("active");
    expect(viewOf(h, "ledger").state).toBe("active");
    expect(h.ctx.get("notes")).toBeDefined();
  });
});

describe("a second row claiming a service another already provides", () => {
  const ONLY_STORE: ModuleSpec[] = [{ id: "store", title: "Storage", required: true }];

  it("fails rather than doubling up: a module has one provider, so its last is its only", async () => {
    const h = await boot(
      [
        { id: "store", name: "store" },
        { id: "spare", name: "store" }
      ],
      ONLY_STORE
    );
    expect(moduleOf(h, "store").providers).toEqual(["store"]);
    expect(viewOf(h, "spare").state).toBe("failed");
    expect(viewOf(h, "spare").error).toMatch(/has been registered/);
    // Which is why swapping a required module's provider is a change of `name`
    // in the composition, not a pair of switches.
    await expect(h.ctx.plugins.setEnabled("store", false)).rejects.toThrow(RequiredModuleError);
  });

  it("lets the row that lost the race be switched off", async () => {
    const h = await boot(
      [
        { id: "store", name: "store" },
        { id: "spare", name: "store" }
      ],
      ONLY_STORE
    );
    await h.ctx.plugins.setEnabled("spare", false);
    expect(viewOf(h, "spare").state).toBe("disabled");
    expect(moduleOf(h, "store").providers).toEqual(["store"]);
  });
});

describe("a required module nothing filled in the first place", () => {
  it("does not lock every other row behind it", async () => {
    // No `ledger` row at all, so the Ledger module is empty from boot. That is
    // not the bystander's doing, and must not be held against it.
    const h = await boot([
      { id: "store", name: "store" },
      { id: "bystander", name: "bystander" }
    ]);
    expect(moduleOf(h, "ledger").providers).toEqual([]);
    await h.ctx.plugins.setEnabled("bystander", false);
    expect(viewOf(h, "bystander").state).toBe("disabled");
  });
});

describe("a row that cannot be loaded", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot([
      { id: "store", name: "store" },
      { id: "ledger", name: "ledger" },
      { id: "ghost", name: "@tomrade/ghost" }
    ]);
  });

  it("is failed with the reason, and the rest boots", () => {
    const ghost = viewOf(h, "ghost");
    expect(ghost.state).toBe("failed");
    expect(ghost.error).toMatch(/Cannot find package/);
    expect(viewOf(h, "store").state).toBe("active");
  });

  it("can still be switched off, so a broken row stops being tried", async () => {
    await h.ctx.plugins.setEnabled("ghost", false);
    expect(viewOf(h, "ghost").state).toBe("disabled");
    expect(h.persisted).toEqual([["ghost", true]]);
  });
});

describe("a row waiting for a service nothing provides", () => {
  it("is pending, and names what it is waiting for", async () => {
    const h = await boot([{ id: "ledger", name: "ledger" }]);
    const view = viewOf(h, "ledger");
    expect(view.state).toBe("pending");
    expect(view.waitingFor).toEqual(["store"]);
    expect(moduleOf(h, "store").providers).toEqual([]);
  });
});

describe("the snapshot", () => {
  it("carries each row's config, so --dump-config still shows what booted", async () => {
    const h = await boot([{ id: "store", name: "store", config: { path: "/tmp/x" } }]);
    const snapshot = h.ctx.plugins.snapshot();
    expect(snapshot.plugins[0]!.config).toEqual({ path: "/tmp/x" });
    expect(snapshot.modules.find((m) => m.id === "store")!.providers).toEqual(["store"]);
  });

  it("starts a row that tomrade.yml ships disabled without loading it", async () => {
    const h = await boot([
      { id: "store", name: "store" },
      { id: "ledger", name: "ledger" },
      { id: "bystander", name: "bystander", disabled: true }
    ]);
    expect(viewOf(h, "bystander").state).toBe("disabled");
    await h.ctx.plugins.setEnabled("bystander", true);
    expect(viewOf(h, "bystander").state).toBe("active");
  });
});
