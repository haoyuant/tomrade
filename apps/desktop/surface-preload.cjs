const { contextBridge, ipcRenderer } = require("electron");

const STATE_CHANNEL = "tomrade-surface:state";
const INTERACTIVE_CHANNEL = "tomrade-surface:interactive";
const MESSAGE_CHANNEL = "tomrade-surface:message";
const PUSH_CHANNEL = "tomrade-surface:push";
const LOOK_CHANNEL = "tomrade-surface:look";

// The app's look as last told; a listener added later hears it at once.
let look = null;
const lookListeners = new Set();
ipcRenderer.on(LOOK_CHANNEL, (_event, next) => {
  look = next;
  for (const listener of lookListeners) listener(next);
});

const listen = (channel) => (listener) => {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

// The bridge is deliberately feature-neutral. A surface owns its document and
// state shape; the shell only carries serializable state, messages, the app's
// look and native hit tests.
contextBridge.exposeInMainWorld("tomradeSurface", {
  onState: listen(STATE_CHANNEL),
  /** Messages the plugin posts, one by one and in order. */
  onMessage: listen(PUSH_CHANNEL),
  /** The theme's CSS variables, dark or not, and the language: now, and on every change. */
  onLook: (listener) => {
    lookListeners.add(listener);
    if (look) listener(look);
    return () => lookListeners.delete(listener);
  },
  setInteractive: (interactive) => ipcRenderer.send(INTERACTIVE_CHANNEL, !!interactive),
  send: (message) => ipcRenderer.send(MESSAGE_CHANNEL, message)
});
