const { contextBridge, ipcRenderer } = require("electron");

// Every channel a plugin contributes is reachable through these two calls, so
// adding one never touches this file. The prefix keeps the bridge to Tomrade's own channels.
const PREFIX = "tomrade:";

contextBridge.exposeInMainWorld("tomrade", {
  invoke: (channel, ...args) => ipcRenderer.invoke(PREFIX + channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(PREFIX + channel, wrapped);
    return () => ipcRenderer.off(PREFIX + channel, wrapped);
  }
});
