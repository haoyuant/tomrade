import { useSyncExternalStore } from "react";

/** A value that changes faster than the panel should render: only components that select from it hear it change. */
export interface LiveStore<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function liveStore<T>(initial: T): LiveStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const was = value;
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (!Object.is(was, value)) for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/** What `select` picks from the store; the component renders again only when that changes (by Object.is), so pick a primitive or a held object. */
export function useLive<T, S>(store: LiveStore<T>, select: (value: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
