// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          defaultProject: "./tsconfig.eslint.json",
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir,
      },
    },
    rules: {
      // Numbers interpolate deterministically; requiring String(n) everywhere is noise.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `_`-prefixed parameters mark intentionally-unused interface arguments.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
