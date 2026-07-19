import { dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// Pre-existing db.query.<table>.findMany() call sites with no `limit`, catalogued when the
// unbounded-findMany rule below was added (Phase 8 of the task-board crash-prevention epic).
// Not fixed here — that's a follow-up pass. Listed so the rule can be `error` for new code
// without failing CI on this debt today. Remove an entry once its call site gets a `limit`.
const unboundedFindManyBaseline = JSON.parse(
  readFileSync(
    new URL("./eslint-unbounded-findmany-baseline.json", import.meta.url),
    "utf-8"
  )
);

// `files` globs treat [...] as a character class, but several baseline paths are Next.js
// dynamic route segments with literal brackets (e.g. "[pageId]") — escape them so the glob
// matches the literal directory name instead of a character class.
const unboundedFindManyBaselineGlobs = unboundedFindManyBaseline.map((p) =>
  p.replace(/[[\]]/g, "\\$&")
);

const unboundedFindManyRule = {
  selector:
    "CallExpression[callee.object.object.object.name='db'][callee.object.object.property.name='query'][callee.property.name='findMany']:not(:has(Property[key.name='limit']))",
  message:
    "db.query.<table>.findMany(...) needs a `limit` in its options object — unbounded findMany() OOM-crashed prod on 2026-07-18. Add `limit: <n>`, or use findFirst() if you only need one row.",
};

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
    // Unbounded db.query.<table>.findMany() calls: production Postgres OOM-crashed on
    // 2026-07-18 because a task-list route called findMany() with no `limit`, on a table
    // that grows without bound. This flags any NEW findMany() call whose options object
    // (or lack of one) has no `limit` key. findFirst() is exempt — it's inherently single-row.
    rules: {
      "no-restricted-syntax": ["error", unboundedFindManyRule],
    },
  },
  {
    // Pre-existing violations of the rule above, downgraded to warn (this repo's lint script
    // exits 0 on warnings — see the react-hooks/exhaustive-deps block below for the same
    // pattern) so CI isn't blocked on debt this phase didn't introduce. Catalogued in
    // eslint-unbounded-findmany-baseline.json; fixing these is a follow-up, not this change.
    files: unboundedFindManyBaselineGlobs,
    rules: {
      "no-restricted-syntax": ["warn", unboundedFindManyRule],
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
  {
    // AI stream surfaces: a stale closure here is not a re-render bug, it is a RUNAWAY AGENT.
    //
    // Streams are server-owned and deliberately survive a client disconnect, so the only thing
    // that stops a generation is an explicit abort naming it correctly. Every stale value in
    // these files — a captured conversationId, a captured messageId, a captured isStreaming —
    // means Stop names the wrong stream (or nothing), the fetch is cancelled, the button flips
    // back to Send, and the server keeps generating, keeps running write tools, and KEEPS
    // BILLING while the user believes it stopped. That has now happened repeatedly.
    //
    // `react-hooks/exhaustive-deps` catches exactly this, and it was already enabled — as a
    // WARNING, via next/core-web-vitals. `bun run lint` exits 0 on warnings, so CI reported
    // "14/14 successful" while the rule was pointing straight at a missing dep in handleStop.
    // The signal existed and was wired to nothing.
    //
    // Scoped to the files that own stream identity, and verified to be at ZERO violations and
    // ZERO suppressions when added — so this costs nothing today and fails CI on the next one.
    // If it fires, do not silence it: a dep you are tempted to omit here is a stop button you
    // are about to break.
    files: [
      "src/hooks/useChannelStreamSocket.ts",
      "src/hooks/useAgentChannelMultiplayer.ts",
      "src/hooks/useAppStateRecovery.ts",
      "src/contexts/GlobalChatContext.tsx",
      "src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx",
      "src/components/layout/middle-content/page-views/dashboard/useGlobalEffectiveStream.ts",
      "src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx",
      "src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx",
      "src/lib/ai/shared/hooks/useChatStop.ts",
      "src/lib/ai/shared/hooks/useChatTransport.ts",
    ],
    rules: {
      "react-hooks/exhaustive-deps": "error",
    },
  },
];

export default eslintConfig;
