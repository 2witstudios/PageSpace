-- Migrate tool ID references from 'create_pr_comment' to 'create_issue_comment'
-- in integration_tool_grants jsonb arrays (allowedTools and deniedTools).
-- The GitHub provider tool was renamed for clarity: the endpoint serves both
-- issues and PRs, and the old name conflicted with the new inline PR review
-- comment tools (create_pr_review, create_pr_review_comment).

UPDATE "integration_tool_grants"
SET "allowed_tools" = (
  SELECT jsonb_agg(
    CASE WHEN elem #>> '{}' = 'create_pr_comment' THEN '"create_issue_comment"'::jsonb
         ELSE elem
    END
  )
  FROM jsonb_array_elements("allowed_tools") AS elem
)
WHERE "allowed_tools" @> '"create_pr_comment"'::jsonb;
--> statement-breakpoint
UPDATE "integration_tool_grants"
SET "denied_tools" = (
  SELECT jsonb_agg(
    CASE WHEN elem #>> '{}' = 'create_pr_comment' THEN '"create_issue_comment"'::jsonb
         ELSE elem
    END
  )
  FROM jsonb_array_elements("denied_tools") AS elem
)
WHERE "denied_tools" @> '"create_pr_comment"'::jsonb;
