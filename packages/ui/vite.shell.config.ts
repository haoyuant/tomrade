import { defineConfig, type Plugin } from "vite";

/** Folds the page's one script into it: the frame then loads a single file from the plugin's own origin, and no module fetch crosses one. */
const singleFile = (): Plugin => ({
  name: "single-file",
  enforce: "post",
  generateBundle(_options, bundle) {
    const page = Object.values(bundle).find((f) => f.type === "asset" && f.fileName.endsWith(".html"));
    const chunk = Object.values(bundle).find((f) => f.type === "chunk");
    if (page?.type !== "asset" || chunk?.type !== "chunk") throw new Error("the layout frame builds to one page and one script");
    page.source = String(page.source).replace(/<script type="module"[^>]*><\/script>/, () => `<script type="module">${chunk.code.replace(/<\/script/gi, "<\\/script")}</script>`);
    delete bundle[chunk.fileName];
  }
});

// The page a sandboxed plugin layout runs in, served by the desktop from the plugin's origin: built apart from the app so it is one self-contained file.
export default defineConfig({
  plugins: [singleFile()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: false, modulePreload: false, rollupOptions: { input: "plugin-layout-shell.html", output: { inlineDynamicImports: true } } }
});
