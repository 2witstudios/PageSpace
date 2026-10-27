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
          paths: [
            {
              name: "@pagespace/db",
              message:
                "Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>",
            },
            {
              name: "@pagespace/lib",
              message:
                "Use a specific subpath import e.g. @pagespace/lib/auth/session-service",
            },
            {
              name: "@pagespace/lib/audit",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/audit/audit-log, not @pagespace/lib/audit)",
            },
            {
              name: "@pagespace/lib/auth",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/auth/session-service, not @pagespace/lib/auth)",
            },
            {
              name: "@pagespace/lib/logging",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/logging/logger-config, not @pagespace/lib/logging)",
            },
            {
              name: "@pagespace/lib/monitoring",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/monitoring/activity-tracker, not @pagespace/lib/monitoring)",
            },
            {
              name: "@pagespace/lib/validators",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/validators/id-validators, not @pagespace/lib/validators)",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
