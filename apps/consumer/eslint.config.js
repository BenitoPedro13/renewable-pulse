// @ts-check
import { baseConfig } from "@renewable-pulse/config/eslint";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(...baseConfig, {
  languageOptions: {
    globals: { ...globals.node },
  },
});
