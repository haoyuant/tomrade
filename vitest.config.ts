import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no package needs building first.
    alias: [
      { find: /^@tomradex\/([^/]+)$/, replacement: `${root}packages/$1/src/index.ts` }
    ]
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"]
  }
});
