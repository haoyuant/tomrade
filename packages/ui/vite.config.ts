import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  // The app window, and the pages built-ins open as windows of their own; the plugin layout frame has vite.shell.config.ts.
  build: { outDir: "dist", rollupOptions: { input: { main: "index.html", "code-sessions": "code-sessions.html" } } }
});
