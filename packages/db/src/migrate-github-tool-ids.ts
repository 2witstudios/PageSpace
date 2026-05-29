/**
 * One-shot data migration for the GitHub integration tool-id rename.
 *
 * The GitHub provider standardised four tool ids onto the `list_*` verb:
 *   get_issues             → list_issues
 *   get_pr_diff            → list_pr_files
 *   get_pr_reviews         → list_pr_reviews
 *   get_pr_review_comments → list_pr_review_comments
 *
 * Live agents store granted tool ids in `integration_tool_grants.allowed_tools`
 * and `denied_tools`. After the rename the old ids no longer match any provider
 * tool, so the runtime gate would silently drop them — an agent that had, say,
 * `get_pr_diff` allowed would quietly lose PR-file access. This script rewrites
 * the old ids to the new ones in those JSON arrays so no grant loses a tool.
 *
 * Scoped to grants on GitHub connections only.
 *
 * Idempotent: a second run finds no old ids and performs zero updates (exit 0).
 * All updates run in one transaction.
 *
 * Usage:
 *   bun run --filter '@pagespace/db' migrate-github-tool-ids
 *   bun run --filter '@pagespace/db' migrate-github-tool-ids -- --dry-run
 */

import { db } from './db';
import {
  integrationProviders,
  integrationConnections,
  integrationToolGrants,
} from './schema/integrations';
import { eq, inArray } from './operators';
import { remapToolIds } from './github-tool-id-renames';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  let grantsUpdated = 0;

  try {
    await db.transaction(async (tx) => {
      const provider = await tx
        .select({ id: integrationProviders.id })
        .from(integrationProviders)
        .where(eq(integrationProviders.slug, 'github'))
        .limit(1);

      if (provider.length === 0) return; // GitHub provider not installed — nothing to do.

      const connections = await tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.providerId, provider[0].id));

      const connectionIds = connections.map((c) => c.id);
      if (connectionIds.length === 0) return;

      const grants = await tx
        .select({
          id: integrationToolGrants.id,
          allowedTools: integrationToolGrants.allowedTools,
          deniedTools: integrationToolGrants.deniedTools,
        })
        .from(integrationToolGrants)
        .where(inArray(integrationToolGrants.connectionId, connectionIds));

      for (const grant of grants) {
        const allowed = remapToolIds(grant.allowedTools);
        const denied = remapToolIds(grant.deniedTools);
        if (!allowed.changed && !denied.changed) continue;

        grantsUpdated += 1;
        if (dryRun) continue;

        await tx
          .update(integrationToolGrants)
          .set({
            ...(allowed.changed ? { allowedTools: allowed.value } : {}),
            ...(denied.changed ? { deniedTools: denied.value } : {}),
          })
          .where(eq(integrationToolGrants.id, grant.id));
      }
    });
  } catch (error) {
    console.error('migrate-github-tool-ids failed:', error);
    process.exit(1);
  }

  console.log(
    dryRun
      ? `[dry-run] Would update ${grantsUpdated} GitHub tool grant(s).`
      : `Updated ${grantsUpdated} GitHub tool grant(s).`
  );
  process.exit(0);
}

main();
