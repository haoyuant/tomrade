import type { Author } from "@tomradex/domain";
import { extensionScope, writeContext } from "@tomradex/write";

/**
 * A call keeps the human flag it arrived with when it stays inside the same
 * plugin; anything else starts as the plugin acting on its own.
 */
export function scopeFor(pluginId: string, human?: boolean) {
  const current = extensionScope.getStore();
  return { pluginId, human: human ?? (current?.pluginId === pluginId && current.human) };
}

/** Always a real Promise, whatever `fn` returns or throws, and always inside the plugin's scope. */
export function within<T>(pluginId: string, fn: () => T, human?: boolean): Promise<Awaited<T>> {
  return new Promise<Awaited<T>>((resolve, reject) => {
    extensionScope.run(scopeFor(pluginId, human), () => {
      try {
        Promise.resolve(fn()).then((value) => resolve(value as Awaited<T>), reject);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Who a write made through the facade is by: the person driving it, the run it serves, or the plugin. */
export function authorFor(pluginId: string): Author {
  const scope = extensionScope.getStore();
  if (scope?.pluginId === pluginId && scope.human) return "human";
  return writeContext.getStore()?.author ?? `ai:${pluginId}`;
}

export class CallbackTimeout extends Error {
  override name = "CallbackTimeout";
}

export function withTimeout<T>(promise: Promise<T>, ms: number | null, label: string): Promise<T> {
  if (ms === null) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallbackTimeout(`${label} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
