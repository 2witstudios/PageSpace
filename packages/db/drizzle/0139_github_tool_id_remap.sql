-- Migrate renamed GitHub tool IDs in integration_tool_grants jsonb arrays.
-- The GitHub provider standardised four tool ids onto the list_* verb:
--   get_issues             -> list_issues
--   get_pr_diff            -> list_pr_files
--   get_pr_reviews         -> list_pr_reviews
--   get_pr_review_comments -> list_pr_review_comments
-- /api/integrations/providers refreshes the builtin provider config to the new
-- ids on deploy, so any grant still referencing the old ids would no longer
-- match a provider tool and would silently lose those capabilities. Rewrite the
-- old ids in stored allowed/denied tool arrays. Idempotent: a re-run matches no
-- rows. Scoped to grants on GitHub connections only — the old ids are generic
-- enough (e.g. get_issues) that a custom provider could legitimately use them,
-- so we join through integration_connections -> integration_providers (slug
-- 'github') before remapping. Mirrors 0091_migrate_create_pr_comment_tool_id.

UPDATE "integration_tool_grants" AS g
SET "allowed_tools" = (
  SELECT jsonb_agg(
    CASE elem #>> '{}'
      WHEN 'get_issues' THEN '"list_issues"'::jsonb
      WHEN 'get_pr_diff' THEN '"list_pr_files"'::jsonb
      WHEN 'get_pr_reviews' THEN '"list_pr_reviews"'::jsonb
      WHEN 'get_pr_review_comments' THEN '"list_pr_review_comments"'::jsonb
      ELSE elem
    END
  )
  FROM jsonb_array_elements(g."allowed_tools") AS elem
)
FROM "integration_connections" AS c
JOIN "integration_providers" AS p ON p."id" = c."provider_id"
WHERE g."connection_id" = c."id"
  AND p."slug" = 'github'
  AND g."allowed_tools" IS NOT NULL
  AND g."allowed_tools" ?| array['get_issues', 'get_pr_diff', 'get_pr_reviews', 'get_pr_review_comments'];
--> statement-breakpoint
UPDATE "integration_tool_grants" AS g
SET "denied_tools" = (
  SELECT jsonb_agg(
    CASE elem #>> '{}'
      WHEN 'get_issues' THEN '"list_issues"'::jsonb
      WHEN 'get_pr_diff' THEN '"list_pr_files"'::jsonb
      WHEN 'get_pr_reviews' THEN '"list_pr_reviews"'::jsonb
      WHEN 'get_pr_review_comments' THEN '"list_pr_review_comments"'::jsonb
      ELSE elem
    END
  )
  FROM jsonb_array_elements(g."denied_tools") AS elem
)
FROM "integration_connections" AS c
JOIN "integration_providers" AS p ON p."id" = c."provider_id"
WHERE g."connection_id" = c."id"
  AND p."slug" = 'github'
  AND g."denied_tools" IS NOT NULL
  AND g."denied_tools" ?| array['get_issues', 'get_pr_diff', 'get_pr_reviews', 'get_pr_review_comments'];
--> statement-breakpoint
-- Also rewrite the tool ids inside the persisted builtin GitHub provider config.
-- The full config (bundles, renamed tool names/descriptions) is refreshed lazily
-- by GET /api/integrations/providers, but that may not run before chat/tool
-- resolution after a deploy. Aligning the stored tool ids here ensures the
-- remapped grants keep matching provider tools in that window (no lost access).
UPDATE "integration_providers"
SET "config" = jsonb_set(
  "config",
  '{tools}',
  (
    SELECT jsonb_agg(
      CASE tool ->> 'id'
        WHEN 'get_issues' THEN jsonb_set(tool, '{id}', '"list_issues"')
        WHEN 'get_pr_diff' THEN jsonb_set(tool, '{id}', '"list_pr_files"')
        WHEN 'get_pr_reviews' THEN jsonb_set(tool, '{id}', '"list_pr_reviews"')
        WHEN 'get_pr_review_comments' THEN jsonb_set(tool, '{id}', '"list_pr_review_comments"')
        ELSE tool
      END
    )
    FROM jsonb_array_elements("config" -> 'tools') AS tool
  )
)
WHERE "slug" = 'github'
  AND "config" -> 'tools' IS NOT NULL
  AND jsonb_typeof("config" -> 'tools') = 'array';
