#!/usr/bin/env bun
/**
 * Backfill Script: Grant trash/restore verb tools to AI_CHAT agents
 *
 * Sub-PR 2 of 3 (additive migration, hard cutover plan).
 *
 * Sub-PR 1 split the discriminated `trash`/`restore` AI tools into explicit
 * per-entity verbs (`trash_page`, `trash_drive`, `restore_page`,
 * `restore_drive`). Per-page AI agents store a curated allowlist of tool names
 * in `pages.enabledTools` (jsonb array). When that allowlist is set, the agent
 * may only call those tools. Sub-PR 3 will remove `trash`/`restore`, so BEFORE
 * that cutover every agent currently allowed `trash` must also be granted the
 * trash verbs, and every agent allowed `restore` the restore verbs.
 *
 * For every `pages` row whose `enabledTools` array contains `"trash"` or
 * `"restore"`, this script appends the corresponding verbs if not already
 * present (preserving existing entries and order). Rows where `enabledTools`
 * is null (unrestricted agents) or contains neither trigger are left
 * untouched. Running it twice produces no changes.
 *
 * Usage:
 *   bun scripts/backfill-trash-verb-tools.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Report what would change without writing to the database.
 */

import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { eq, sql } from '@pagespace/db/operators';
import {
  addTrashVerbTools,
  TRASH_TRIGGER,
  RESTORE_TRIGGER,
} from './lib/trash-verb-tools';

async function backfill(dryRun: boolean): Promise<void> {
  console.log(
    `🚀 Backfilling enabledTools with trash/restore verb tools${dryRun ? ' (dry run)' : ''}...`,
  );

  // Narrow to candidate rows in SQL: jsonb arrays that contain "trash" or
  // "restore" (the `@>` containment operator, mirroring the task-verb backfill).
  const rows = await db
    .select({ id: pages.id, enabledTools: pages.enabledTools })
    .from(pages)
    .where(
      sql`${pages.enabledTools} @> ${JSON.stringify([TRASH_TRIGGER])}::jsonb OR ${pages.enabledTools} @> ${JSON.stringify([RESTORE_TRIGGER])}::jsonb`,
    );

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    scanned += 1;

    if (!Array.isArray(row.enabledTools)) {
      // The ?| filter only matches jsonb arrays (or objects); this guards the
      // unexpected (e.g. a jsonb scalar) rather than corrupting the value.
      console.warn(`⚠️  Skipping page ${row.id}: enabledTools is not an array.`);
      skipped += 1;
      continue;
    }

    const next = addTrashVerbTools(row.enabledTools);
    if (next.length === row.enabledTools.length) {
      // Already has every needed verb — no change required (idempotent).
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
