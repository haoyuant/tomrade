const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Every channel a plugin contributes is reachable through these two calls, so
// adding one never touches this file. The prefix keeps the bridge to Tomrade's own channels.
const PREFIX = "tomrade:";

contextBridge.exposeInMainWorld("tomrade", {
  invoke: (channel, ...args) => ipcRenderer.invoke(PREFIX + channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(PREFIX + channel, wrapped);
    return () => ipcRenderer.off(PREFIX + channel, wrapped);
  },
  // File.path was removed in Electron 32; this is the replacement, and it must
  // run here in the preload world since a File can't cross into the main process.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // A window a tab moved into keeps its tabs and panes to itself.
  window: { detached: process.argv.includes("--tomrade-window=detached") }
});
