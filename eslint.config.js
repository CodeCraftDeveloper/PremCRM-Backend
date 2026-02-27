import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["node_modules", "coverage", "__tests__", "scripts"]),
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^(_|next$)",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^(_|error$|err$)",
        },
      ],
      "no-console": "off",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "off",
    },
  },
]);
