#!/usr/bin/env bun
/**
 * Backfill Script: Create an empty Home drive for every existing user
 *
 * PR 4 of 5 — Home Drive epic (branch: pu/starting-drive).
 *
 * New signups get their Home drive from provisioning (PR 3). Password/passkey
 * sign-in routes never call provisioning, so a one-time backfill is MANDATORY
 * for all users created before PR 3 lands.
 *
 * Each user receives a fresh, EMPTY Home drive (kind='HOME'). Their existing
 * drives — including any "Getting Started" drive — are never touched.
 *
 * The insert uses onConflictDoNothing targeting the partial unique index
 * drives_owner_home_unique (ownerId WHERE kind='HOME'), so a concurrent lazy
 * provisioning race is a silent skip, not an error. Running the script twice
 * is equally safe (the missing set is re-derived from the DB each run).
 *
 * Usage:
 *   bun scripts/backfill-home-drives.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Report how many users lack a Home drive without inserting.
 *
 * ─── Production procedure (Fly) ────────────────────────────────────────────
 * 1. Deploy the schema migration (adds kind column + partial unique index).
 * 2. Deploy the new app image (provisioning + guards from PRs 1–3).
 * 3. Run this script as a one-off machine on the migrate image:
 *
 *      fly machine run <migrate-image> \
 *        --app pagespace \
 *        --env DATABASE_URL="$DATABASE_URL" \
 *        -- bun scripts/backfill-home-drives.ts
 *
 *    apps/web/Dockerfile.migrate already copies scripts/ into the image.
 *    DO NOT run this script against production yourself — document only.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createId } from '@paralleldrive/cuid2';
import { db as defaultDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { eq, and, gt, asc, inArray, sql } from '@pagespace/db/operators';
import { computeHomeBackfillInserts } from './lib/home-drive-backfill';

const BATCH_SIZE = 500;

export type BackfillResult = { inserted: number; skipped: number };

type DbLike = Pick<typeof defaultDb, 'select' | 'insert'>;

export async function backfill(dryRun: boolean, dbInstance: DbLike = defaultDb): Promise<BackfillResult> {
  console.log(`🚀 Backfilling Home drives${dryRun ? ' (dry run)' : ''}...`);

  let inserted = 0;
  let skipped = 0;
  let cursor = '';

  for (;;) {
    // One row per user: homeDriveId is null when the user lacks a Home drive.
    const batch = await (dbInstance as typeof defaultDb)
      .select({ userId: users.id, homeDriveId: drives.id })
      .from(users)
      .leftJoin(drives, and(eq(drives.ownerId, users.id), eq(drives.kind, 'HOME')))
      .where(gt(users.id, cursor))
      .orderBy(asc(users.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    const needsHome = batch.filter((row) => row.homeDriveId === null);
    const alreadyHasHome = batch.length - needsHome.length;
    skipped += alreadyHasHome;

    if (needsHome.length > 0) {
      if (dryRun) {
        // In dry-run, count projected inserts so the summary is accurate.
        inserted += needsHome.length;
        console.log(`  would insert ${needsHome.length} Home drives (cursor: ${cursor || '<start>'})`);
      } else {
        const userIds = needsHome.map((r) => r.userId);

        // Fetch all drive slugs for users lacking Home (for collision avoidance).
        const slugRows = await (dbInstance as typeof defaultDb)
          .select({ ownerId: drives.ownerId, slug: drives.slug })
          .from(drives)
          .where(inArray(drives.ownerId, userIds));

        const slugsByOwner = new Map<string, string[]>();
        for (const { ownerId, slug } of slugRows) {
          const list = slugsByOwner.get(ownerId) ?? [];
          list.push(slug);
          slugsByOwner.set(ownerId, list);
        }

        const toInsert = computeHomeBackfillInserts(
          needsHome.map((row) => ({
            userId: row.userId,
            hasHome: false,
            existingSlugs: slugsByOwner.get(row.userId) ?? [],
          })),
        );

        const now = new Date();
        const rows = toInsert.map((r) => ({
          id: createId(),
          ...r,
          // kind must be explicit — the DB default is STANDARD, not HOME.
          kind: 'HOME' as const,
          createdAt: now,
          updatedAt: now,
        }));

        // Use .returning() so the count reflects only rows actually written,
        // not the attempted batch size (onConflictDoNothing skips races).
        const written = await (dbInstance as typeof defaultDb)
          .insert(drives)
          .values(rows)
          .onConflictDoNothing({
            target: [drives.ownerId],
            targetWhere: sql`"kind" = 'HOME'`,
          })
          .returning({ id: drives.id });

        inserted += written.length;
      }
    }

    cursor = batch[batch.length - 1].userId;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(
    `✅ Backfill ${dryRun ? 'dry run ' : ''}complete. ${
      dryRun
        ? `would insert: ${inserted}, already have Home: ${skipped}`
        : `inserted: ${inserted}, already had Home: ${skipped}`
    }`,
  );

  return { inserted, skipped };
}

if (import.meta.main) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  backfill(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Backfill failed:', error);
      process.exit(1);
    });
}
