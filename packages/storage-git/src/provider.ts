// cordis first: @tomrade/storage augments it, and a `declare module "cordis"`
// reached before cordis itself declares a new module instead of augmenting one.
import type {} from "cordis";
import type { z } from "zod";
import type { RemoteTarget, StorageProvider } from "@tomrade/storage";

export interface RemoteProviderOptions<C> {
  id: string;
  title: string;
  description?: string;
  configSchema: z.ZodType<C>;
  defaults: C;
  settingsSection?: string;
  /** Passed through: a hosting provider supplies the account and the shortcuts. */
  connection?: StorageProvider<C>["connection"];
  draft?: StorageProvider<C>["draft"];
  toRemote(config: C): Promise<RemoteTarget> | RemoteTarget;
  /** Bring the destination into existence — create the repository, say. */
  ensureRemote?(config: C): Promise<void>;
  browse?(): Promise<{ label: string; config: C }[]>;
}

/**
 * A remote transport for a project's own repository. The provider resolves its
 * non-secret config to a git remote; Tomrade drives git in the project folder
 * itself, so there is no clone to keep and nothing here touches a file.
 */
export function createRemoteProvider<C>(opts: RemoteProviderOptions<C>): StorageProvider<C> {
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    configSchema: opts.configSchema,
    defaults: opts.defaults,
    settingsSection: opts.settingsSection,
    browse: opts.browse,
    draft: opts.draft,
    connection: opts.connection,
    toRemote: opts.toRemote,
    ensureRemote: opts.ensureRemote
  };
}
