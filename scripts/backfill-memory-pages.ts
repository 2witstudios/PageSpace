import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { and, asc, eq, gt, isNull, or } from '@pagespace/db/operators';
import {
  provisionMemoryPages,
  MEMORY_FIELDS,
  type MemoryField,
} from '@pagespace/lib/memory/memory-pages';

/**
 * One-shot backfill: move every existing user's personalization profile out of
 * the `user_personalization` text columns and into pages in their Home drive.
 *
 * New signups get their Memory pages during `provisionHomeDriveIfNeeded`, but
 * that path only runs when a Home drive is CREATED, so existing users never
 * pass through it. This script covers them — deliberately as a script rather
 * than a per-login hook, so the hot auth path stays untouched.
 *
 * Safe to re-run. Idempotence comes from the page pointers plus a content
 * check, not a stamp:
 *   - `provisionMemoryPages` reuses pages that already exist.
 *   - Column content is copied ONLY into a page that is currently empty, so a
 *     second run never re-appends, and never overwrites edits the user (or the
 *     memory cron) has made to the page since the first run.
 *
 * The legacy columns are left in place. They are the fallback read path in
 * `personalization-utils` until the follow-up PR drops them.
 *
 * Usage:
 *   bun scripts/backfill-memory-pages.ts --dry-run
 *   bun scripts/backfill-memory-pages.ts
 */

const BATCH_SIZE = 200;

/** Legacy column on `user_personalization` holding each field's content. */
const LEGACY_COLUMN = {
  bio: 'bio',
  writingStyle: 'writingStyle',
  rules: 'rules',
} as const;

export interface BackfillSummary {
  scanned: number;
  /** Users that had at least one field copied into a page. */
  migrated: number;
  /** Individual field pages that received content. */
  fieldsCopied: number;
  /** Fields skipped because the target page already had content. */
  fieldsSkippedNonEmpty: number;
  /** Users whose columns were all empty — pages provisioned, nothing to copy. */
  emptyProfiles: number;
  failed: number;
}

export async function runBackfill({
  dryRun = false,
}: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const db = getMigrationDb();
  const summary: BackfillSummary = {
    scanned: 0,
    migrated: 0,
    fieldsCopied: 0,
    fieldsSkippedNonEmpty: 0,
    emptyProfiles: 0,
    failed: 0,
  };

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Backfilling personalization into Memory pages\n`);

  // Keyset pagination on the personalization row id. Unlike the starter-skills
  // backfill this predicate is NOT mutated by the loop (no stamp column), but
  // keyset is still the right walk: an OFFSET over a table taking concurrent
  // inserts can skip rows.
  let cursor = '';
  for (;;) {
    const batch = await db
      .select({
        id: userPersonalization.id,
        userId: userPersonalization.userId,
        driveId: drives.id,
        bio: userPersonalization.bio,
        writingStyle: userPersonalization.writingStyle,
        rules: userPersonalization.rules,
        bioPageId: userPersonalization.bioPageId,
        writingStylePageId: userPersonalization.writingStylePageId,
        rulesPageId: userPersonalization.rulesPageId,
      })
      .from(userPersonalization)
      .innerJoin(users, eq(users.id, userPersonalization.userId))
      .innerJoin(drives, and(eq(drives.ownerId, users.id), eq(drives.kind, 'HOME')))
      .where(
        and(
          gt(userPersonalization.id, cursor),
          // Only rows that still need work: no folder pointer yet, or a field
          // whose page pointer was never written.
          or(
            isNull(userPersonalization.memoryFolderId),
            isNull(userPersonalization.bioPageId),
            isNull(userPersonalization.writingStylePageId),
            isNull(userPersonalization.rulesPageId),
          ),
        ),
      )
      .orderBy(asc(userPersonalization.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      summary.scanned++;

      const populated = MEMORY_FIELDS.filter((field) => (row[LEGACY_COLUMN[field]] ?? '').trim());

      if (dryRun) {
        if (populated.length === 0) {
          summary.emptyProfiles++;
        } else {
          summary.migrated++;
          summary.fieldsCopied += populated.length;
          console.log(`  user ${row.userId}: would copy ${populated.join(', ')}`);
        }
        continue;
      }

      try {
        // One transaction per user: a failure isolates to that user rather than
        // rolling back a whole batch of unrelated migrations.
        const copied = await db.transaction(async (tx) => {
          const pointers = await provisionMemoryPages(row.userId, row.driveId, tx);

          const pageIdFor: Record<MemoryField, string> = {
            bio: pointers.bioPageId,
            writingStyle: pointers.writingStylePageId,
            rules: pointers.rulesPageId,
          };

          const written: MemoryField[] = [];
          for (const field of populated) {
            const content = (row[LEGACY_COLUMN[field]] ?? '').trim();

            // Copy into the page only while it is still empty. This is what
            // makes a re-run safe: once the page has content — from the first
            // run, the memory cron, or the user typing in it — we never touch
            // it again.
            const updated = await tx
              .update(pages)
              .set({ content, contentMode: 'markdown', updatedAt: new Date() })
              .where(and(eq(pages.id, pageIdFor[field]), eq(pages.content, '')))
              .returning({ id: pages.id });

            if (updated.length > 0) {
              written.push(field);
            } else {
              summary.fieldsSkippedNonEmpty++;
            }
          }

          // Retire ALL THREE columns in the SAME transaction — not just the ones
          // this run copied.
          //
          // The read path in `personalization-utils` stops consulting a column
          // the moment its POINTER is set, regardless of what the column holds.
          // Provisioning above sets all three pointers, so every column is now
          // unreachable. Clearing only the copied ones would leave a populated,
          // invisible column behind for any field whose page already had content
          // (a hand edit made before this ran, say) — and that is a latent
          // privacy leak, not dead weight: if the user later deletes the page,
          // `purgeExpiredTrashedPages` hard-deletes it, `ON DELETE SET NULL`
          // clears the pointer, the pointer-absent fallback switches back on and
          // resurrects content the user never saw and cannot reach.
          //
          // Nothing observable is lost. A column the reader can no longer reach
          // is not a second copy to keep in step; the page is the source of
          // truth from here on, which is exactly what the settings screen shows.
          await tx
            .update(userPersonalization)
            .set({ bio: null, writingStyle: null, rules: null, updatedAt: new Date() })
            .where(eq(userPersonalization.userId, row.userId));

          return written;
        });

        if (populated.length === 0) {
          summary.emptyProfiles++;
        } else if (copied.length > 0) {
          summary.migrated++;
          summary.fieldsCopied += copied.length;
          console.log(`  user ${row.userId}: copied ${copied.join(', ')}`);
        }
      } catch (error) {
        summary.failed++;
        console.error(`  user ${row.userId}: FAILED`, error);
      }
    }

    console.log(`  …${summary.scanned} profiles scanned`);
  }

  console.log(
    `\nDone${dryRun ? ' (dry run — nothing written)' : ''}. ` +
      `${summary.scanned} profile(s) scanned, ${summary.migrated} migrated, ` +
      `${summary.fieldsCopied} field(s) copied, ` +
      `${summary.fieldsSkippedNonEmpty} skipped (page already had content), ` +
      `${summary.emptyProfiles} empty, ${summary.failed} failed.`,
  );
  return summary;
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  runBackfill({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
