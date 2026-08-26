// @ts-check
import tseslint from "typescript-eslint";

/** Shared flat-config base. Apps extend this array and append their own
 * framework plugin on top. */
export const baseConfig = tseslint.config(
  {
    ignores: ["dist/**", ".next/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);

export default baseConfig;
