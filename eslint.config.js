import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "web/dist/**", "node_modules/**", "coverage/**", "runtime/**", "Data_Resume/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off",
      "no-console": "off",
    },
  },
  {
    // React event handlers may be async; the returned promise is intentionally not awaited by React.
    files: ["web/src/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }] },
  },
);
