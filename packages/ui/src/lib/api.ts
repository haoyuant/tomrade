import type { Invoke, Subscribe } from "@tomrade/ipc";

/** The renderer's whole surface onto the main process: typed by the channels plugins contribute. */
export const invoke: Invoke = (channel, ...args) => window.tomrade.invoke(channel, ...args);

export const subscribe: Subscribe = (channel, listener) => window.tomrade.on(channel, listener);
