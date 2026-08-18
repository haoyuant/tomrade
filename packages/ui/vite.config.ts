import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist" }
});
