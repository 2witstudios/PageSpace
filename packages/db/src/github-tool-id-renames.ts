/**
 * Single source of truth for the GitHub integration tool-id rename.
 *
 * The GitHub provider standardised four tool ids onto the `list_*` verb. Stored
 * agent grants reference the old ids, so the data migration in
 * `migrate-github-tool-ids.ts` rewrites them. Kept in its own module (free of
 * any db import) so the pure remap can be unit-tested without booting the
 * migration script.
 */

/** Old → new GitHub tool id mapping. */
export const GITHUB_TOOL_ID_RENAMES: Record<string, string> = {
  get_issues: 'list_issues',
  get_pr_diff: 'list_pr_files',
  get_pr_reviews: 'list_pr_reviews',
  get_pr_review_comments: 'list_pr_review_comments',
};

/**
 * Rewrite renamed tool ids inside a stored allowed/denied tools value.
 * Pure: returns the original reference (and changed=false) when nothing changed,
 * so callers can skip no-op writes. Non-array values pass through untouched.
 */
export function remapToolIds(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };

  let changed = false;
  const next = value.map((id) => {
    if (typeof id === 'string' && GITHUB_TOOL_ID_RENAMES[id]) {
      changed = true;
      return GITHUB_TOOL_ID_RENAMES[id];
    }
    return id;
  });

  return changed ? { value: next, changed: true } : { value, changed: false };
}
