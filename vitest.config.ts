import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no package needs building first.
    alias: [
      { find: /^@tomrade\/example-([^/]+)$/, replacement: `${root}examples/$1/src/index.ts` },
      { find: /^@tomrade\/review$/, replacement: `${root}apps/review/src/index.ts` },
      { find: /^@tomrade\/([^/]+)$/, replacement: `${root}packages/$1/src/index.ts` }
    ]
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "examples/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"]
  }
});
