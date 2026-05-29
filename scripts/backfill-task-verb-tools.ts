#!/usr/bin/env bun
/**
 * Backfill Script: Grant task verb tools to AI_CHAT agents
 *
 * Sub-PR 2 of 3 (additive migration, hard cutover plan).
 *
 * Sub-PR 1 split the monolithic `update_task` AI tool into explicit verbs
 * (`create_task`, `delete_task`, `reorder_task`). Per-page AI agents store a
 * curated allowlist of tool names in `pages.enabledTools` (jsonb array). When
 * that allowlist is set, the agent may only call those tools. Sub-PR 3 will
 * narrow `update_task` to field-only edits, so BEFORE that cutover every agent
 * currently allowed `update_task` must also be granted the new verbs.
 *
 * For every `pages` row whose `enabledTools` array contains `"update_task"`,
 * this script appends `"create_task"`, `"delete_task"`, `"reorder_task"` if not
 * already present (preserving existing entries and order). Rows where
 * `enabledTools` is null (unrestricted agents) or does not contain
 * `update_task` are left untouched. Running it twice produces no changes.
 *
 * Usage:
 *   bun scripts/backfill-task-verb-tools.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Report what would change without writing to the database.
 */

import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { eq, sql } from '@pagespace/db/operators';
import {
  addTaskVerbTools,
  isStringArray,
  TRIGGER_TOOL,
} from './lib/task-verb-tools';

async function backfill(dryRun: boolean): Promise<void> {
  console.log(
    `🚀 Backfilling enabledTools with task verb tools${dryRun ? ' (dry run)' : ''}...`,
  );

  // Narrow to candidate rows in SQL: jsonb arrays that contain "update_task".
  const rows = await db
    .select({ id: pages.id, enabledTools: pages.enabledTools })
    .from(pages)
    .where(sql`${pages.enabledTools} @> ${JSON.stringify([TRIGGER_TOOL])}::jsonb`);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    scanned += 1;

    if (!isStringArray(row.enabledTools)) {
      // Defensive: the @> filter matches jsonb arrays, but guard against any
      // legacy non-string entries rather than corrupting the value.
      console.warn(`⚠️  Skipping page ${row.id}: enabledTools is not a string array.`);
      skipped += 1;
      continue;
    }

    const next = addTaskVerbTools(row.enabledTools);
    if (next.length === row.enabledTools.length) {
      // Already has every verb — no change needed (idempotent).
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `  would update page ${row.id}: [${row.enabledTools.join(', ')}] -> [${next.join(', ')}]`,
      );
    } else {
      await db.update(pages).set({ enabledTools: next }).where(eq(pages.id, row.id));
    }
    updated += 1;
  }

  console.log(
    `✅ Backfill ${dryRun ? 'dry run ' : ''}complete. scanned: ${scanned}, ${
      dryRun ? 'would update' : 'updated'
    }: ${updated}, unchanged: ${skipped}`,
  );
}

if (require.main === module) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  backfill(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Backfill failed:', error);
      process.exit(1);
    });
}

export { backfill };
