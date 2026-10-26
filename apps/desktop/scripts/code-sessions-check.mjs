// The Terminal window's end-to-end check, on the backend this platform's panes run on: herdr on macOS and Linux,
// Tomrade's own terminal host on native Windows, where herdr cannot attach.
await import(process.platform === "win32" ? "./code-sessions-builtin-check.mjs" : "./code-sessions-herdr-check.mjs");
