import type { Invoke, Subscribe } from "@tomradex/ipc";

/** The renderer's whole surface onto the main process: typed by the channels plugins contribute. */
export const invoke: Invoke = (channel, ...args) => window.tomrade.invoke(channel, ...args);

export const subscribe: Subscribe = (channel, listener) => window.tomrade.on(channel, listener);

/** Contribution descriptors name optional plugin channels at runtime. */
export const invokeDynamic = (channel: string, ...args: unknown[]): Promise<unknown> =>
  (window.tomrade.invoke as unknown as (channel: string, ...args: unknown[]) => Promise<unknown>)(channel, ...args);

/** Runtime companion to invokeDynamic for a descriptor's change broadcast. */
export const subscribeDynamic = (channel: string, listener: (...args: unknown[]) => void): (() => void) =>
  (window.tomrade.on as unknown as (channel: string, listener: (...args: unknown[]) => void) => () => void)(channel, listener);

/** An error's own words, without the "Error invoking remote method" wrapper Electron adds. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
