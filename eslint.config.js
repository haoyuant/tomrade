import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/out/**", "apps/desktop/ui/**", "apps/desktop/release/**", "apps/desktop/vendor/**", "apps/desktop/official-plugins/**", "apps/desktop/scripts/shots/**"]
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommended],
    // Style rules the codebase does not follow: meeting them would be mass edits, not bug fixes.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "prefer-const": "off"
    }
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    // A suppression that no longer hides anything fails, so stale ones cannot pile up again.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    // The two classic rules only: the React Compiler ones target code written for the compiler, which this is not.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
