import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "types/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    files: ["tests/**/*.js", "tools/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-globals": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // Command-line tools report to the console.
  { files: ["tools/**/*.mjs"], rules: { "no-console": "off" } },
];
