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
              name: "@pagespace/lib/content",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/content/tree-utils, not @pagespace/lib/content)",
            },
            {
              name: "@pagespace/lib/encryption",
              message:
                "Use the specific leaf subpath: @pagespace/lib/encryption/encryption-utils",
            },
            {
              name: "@pagespace/lib/integrations",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/integrations/types, not @pagespace/lib/integrations)",
            },
            {
              name: "@pagespace/lib/integrations/providers",
              message:
                "Use @pagespace/lib/integrations/providers/builtin-providers",
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
              name: "@pagespace/lib/notifications",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/notifications/notifications, not @pagespace/lib/notifications)",
            },
            {
              name: "@pagespace/lib/permissions",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/permissions/permissions, not @pagespace/lib/permissions)",
            },
            {
              name: "@pagespace/lib/repositories",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/repositories/page-repository, not @pagespace/lib/repositories)",
            },
            {
              name: "@pagespace/lib/security",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/security/url-validator, not @pagespace/lib/security)",
            },
            {
              name: "@pagespace/lib/sheets",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/sheets/sheet, not @pagespace/lib/sheets)",
            },
            {
              name: "@pagespace/lib/utils",
              message:
                "Use the specific leaf subpath (e.g. @pagespace/lib/utils/enums, not @pagespace/lib/utils)",
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
  {
    // Edge-runtime import graph: middleware.ts and every module it
    // (transitively) imports compiles for the Edge runtime, where db access
    // and @pagespace/lib's Node-only logger crash at request time — the
    // 2026-07-07 prod outage. The next.config.ts edge build guard is the
    // backstop; this rule surfaces the mistake in the editor/lint instead of
    // at build. Keep this file list in sync with middleware.ts's imports.
    files: [
      "src/middleware.ts",
      "src/middleware/monitoring.ts",
      "src/middleware/security-headers.ts",
      "src/lib/auth/origin-validation.ts",
      "src/lib/auth/cookie-config.ts",
      "src/lib/auth/token-prefixes.ts",
      "src/lib/logging/edge-logger.ts",
      "src/lib/request-id/request-id.ts",
      "src/lib/monitoring/ingest-sanitizer.ts",
      "src/lib/well-known/rewrites.ts",
      "src/lib/security/edge-client-ip.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // `paths` entries match the exact specifier only — required for the
          // @/lib/auth barrel ban, since a gitignore-style `group` pattern
          // would also match the allowed leaf modules under @/lib/auth/*.
          paths: [
            {
              name: "@/lib/auth",
              message:
                "Edge-runtime middleware graph: the @/lib/auth barrel drags in db + sessions + permissions. Import the specific leaf (e.g. @/lib/auth/token-prefixes, @/lib/auth/origin-validation).",
            },
            {
              name: "@/lib/auth/index",
              message:
                "Edge-runtime middleware graph: the @/lib/auth barrel drags in db + sessions + permissions. Import the specific leaf (e.g. @/lib/auth/token-prefixes, @/lib/auth/origin-validation).",
            },
          ],
          patterns: [
            {
              group: ["@pagespace/db", "@pagespace/db/*"],
              message:
                "Edge-runtime middleware graph: no database access. Persist via the /api/internal/monitoring/ingest route (Node runtime) instead.",
            },
            {
              // Everything under @pagespace/lib except api-contract-version
              // (a pure constant that security-headers.ts legitimately
              // bundles into the edge build).
              regex: "^@pagespace/lib(?!/api-contract-version$)(/.*)?$",
              message:
                "Edge-runtime middleware graph: @pagespace/lib is Node-only (logger uses os/process.on; many leaves import the db). Use edge-safe leaf modules under apps/web/src, e.g. @/lib/logging/edge-logger.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
