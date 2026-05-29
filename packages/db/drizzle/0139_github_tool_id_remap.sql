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
-- rows. Mirrors 0091_migrate_create_pr_comment_tool_id.

UPDATE "integration_tool_grants"
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
  FROM jsonb_array_elements("allowed_tools") AS elem
)
WHERE "allowed_tools" IS NOT NULL
  AND "allowed_tools" ?| array['get_issues', 'get_pr_diff', 'get_pr_reviews', 'get_pr_review_comments'];
--> statement-breakpoint
UPDATE "integration_tool_grants"
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
  FROM jsonb_array_elements("denied_tools") AS elem
)
WHERE "denied_tools" IS NOT NULL
  AND "denied_tools" ?| array['get_issues', 'get_pr_diff', 'get_pr_reviews', 'get_pr_review_comments'];
