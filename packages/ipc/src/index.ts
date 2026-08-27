import type {} from "cordis";

/**
 * Plugins add channels by augmenting this interface, so one declaration types
 * the handler in the main process and the call in the renderer.
 */
export interface Channels {}

/** Events the main process pushes to every window. */
export interface Broadcasts {}

export type ChannelName = keyof Channels & string;
export type BroadcastName = keyof Broadcasts & string;

type Args<F> = F extends (...args: infer P) => unknown ? P : never;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

export type ChannelHandler<K extends ChannelName> = (...args: Args<Channels[K]>) => Result<Channels[K]> | Promise<Result<Channels[K]>>;

export type Invoke = <K extends ChannelName>(channel: K, ...args: Args<Channels[K]>) => Promise<Result<Channels[K]>>;

export type Subscribe = <K extends BroadcastName>(channel: K, listener: (...args: Args<Broadcasts[K]>) => void) => () => void;

export interface Ipc {
  /** Reversible: the channel is removed when the registering plugin unloads. */
  handle<K extends ChannelName>(channel: K, handler: ChannelHandler<K>): () => void;
  send<K extends BroadcastName>(channel: K, ...args: Args<Broadcasts[K]>): void;
}

declare module "cordis" {
  interface Context {
    ipc: Ipc;
  }
}
