const { contextBridge, ipcRenderer } = require("electron");

const STATE_CHANNEL = "tomrade-surface:state";
const INTERACTIVE_CHANNEL = "tomrade-surface:interactive";
const MESSAGE_CHANNEL = "tomrade-surface:message";

// The bridge is deliberately feature-neutral. A surface owns its document and
// state shape; the shell only carries serializable state and native hit tests.
contextBridge.exposeInMainWorld("tomradeSurface", {
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on(STATE_CHANNEL, wrapped);
    return () => ipcRenderer.off(STATE_CHANNEL, wrapped);
  },
  setInteractive: (interactive) => ipcRenderer.send(INTERACTIVE_CHANNEL, !!interactive),
  send: (message) => ipcRenderer.send(MESSAGE_CHANNEL, message)
});
