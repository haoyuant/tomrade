import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The promo film's page (src/promo): the app's own stylesheet and components, drawn as a function of the frame.
// `pnpm promo` builds it and films it (apps/desktop/scripts/promo-render.mjs); `pnpm promo:preview` plays it in a browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 5183, open: "/promo.html" },
  build: { outDir: "../../out/promo/_page", emptyOutDir: true, rollupOptions: { input: "promo.html" } }
});
