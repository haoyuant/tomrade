import type { Context } from "cordis";
import { ConflictError, ExtensionAuthorError, HumanLockedError, PurgeNotPermittedError, isAi, type Item } from "@tomradex/domain";
import { extensionScope } from "./context.js";

/** AI writers may never touch these fields on a human-locked item. */
export const LOCKED_FIELDS = ["title", "body"] as const;

/** Only AI writes are refused on a locked item; the asymmetry is about ownership, not staleness. */
export const humanLock = {
  name: "write-policy:human-lock",
  apply(ctx: Context) {
    ctx.on("write/pre-commit", (intent, next) => {
      if (intent.entity === "item" && intent.op === "update" && isAi(intent.by)) {
        const patch = intent.patch ?? {};
        if ("humanLocked" in patch) throw new HumanLockedError(intent.id, ["humanLocked"]);
        const touched = LOCKED_FIELDS.filter((f) => f in patch);
        if ((intent.before as Item | null)?.humanLocked && touched.length) throw new HumanLockedError(intent.id, touched);
      }
      return next();
    });
  }
};

/** The one write undo cannot reach is closed to every author but a human. */
export const humanOnlyPurge = {
  name: "write-policy:human-only-purge",
  apply(ctx: Context) {
    ctx.on("write/pre-commit", (intent, next) => {
      if (intent.op === "purge" && intent.by !== "human") throw new PurgeNotPermittedError(intent.id, intent.by);
      return next();
    });
  }
};

/**
 * An extension may write as a person only while a person is driving it; left
 * to itself it is one more AI author, which also keeps purge out of its reach.
 */
export const extensionAuthorship = {
  name: "write-policy:extension-authorship",
  apply(ctx: Context) {
    ctx.on("write/pre-commit", (intent, next) => {
      if (intent.via && intent.by === "human" && !extensionScope.getStore()?.human) throw new ExtensionAuthorError(intent.via, intent.entity, intent.op);
      return next();
    });
  }
};

/** A supplied baseVersion is enforced for every author — that is what makes a conflict visible. */
export const optimisticVersion = {
  name: "write-policy:optimistic-version",
  apply(ctx: Context) {
    ctx.on("write/pre-commit", (intent, next) => {
      const current = (intent.before as { version?: number } | null)?.version;
      if (intent.baseVersion !== undefined && typeof current === "number" && intent.baseVersion !== current) {
        throw new ConflictError(intent.id, intent.baseVersion, current);
      }
      return next();
    });
  }
};

/** The default policy. Order matters: the lock names the real problem before staleness does. */
export const policy = {
  name: "write-policy",
  async apply(ctx: Context) {
    await ctx.plugin(extensionAuthorship);
    await ctx.plugin(humanLock);
    await ctx.plugin(humanOnlyPurge);
    await ctx.plugin(optimisticVersion);
  }
};
