import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@pagespace/db"],
              message:
                "Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>",
            },
            {
              group: ["@pagespace/lib"],
              message:
                "Use direct subpath imports: @pagespace/lib/<module>/<file>",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
