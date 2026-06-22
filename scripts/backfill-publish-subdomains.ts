#!/usr/bin/env bun
/**
 * Backfill Script: Allocate a globally-unique publishSubdomain to every existing
 * drive that lacks one.
 *
 * Phase 1 of the wildcard-subdomains epic (branch: pu/wildcard-subdomains).
 *
 * New drives get a publishSubdomain at creation (drive-service + home-drive
 * provisioning). Every drive created before that lands needs a one-time backfill
 * so it is addressable at <sub>.pagespace.site.
 *
 * For each missing drive, a unique subdomain is computed from its slug (de-duped
 * against ALL existing subdomains, not just the missing batch). Writes happen
 * one drive at a time; the DB unique constraint on publishSubdomain is the final
 * race arbiter — on a conflict the row is skipped (its slug already collided; a
 * later re-run will assign it the next free suffix).
 *
 * Usage:
 *   bun scripts/backfill-publish-subdomains.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Report how many drives lack a subdomain without writing.
 *
 * Idempotent: a re-run only touches drives still missing a subdomain.
 */

import { db as defaultDb } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { eq, and, isNull, isNotNull, gt, asc } from '@pagespace/db/operators';
import { computePublishSubdomainBackfill } from './lib/publish-subdomain-backfill';

const BATCH_SIZE = 500;

export type BackfillResult = { allocated: number; skipped: number };

type DbLike = Pick<typeof defaultDb, 'select' | 'update'>;

export async function backfill(dryRun: boolean, dbInstance: DbLike = defaultDb): Promise<BackfillResult> {
  console.log(`🚀 Backfilling publish subdomains${dryRun ? ' (dry run)' : ''}...`);

  let allocated = 0;
  let skipped = 0;
  let cursor = '';

  // Fetch the full taken set ONCE (all non-null subdomains), then keep it current as
  // we allocate. Refreshing it per batch would be O(batches × total drives) — avoid that.
  const takenRows = await (dbInstance as typeof defaultDb)
    .select({ subdomain: drives.publishSubdomain })
    .from(drives)
    .where(isNotNull(drives.publishSubdomain));
  const taken = new Set(
    takenRows
      .map((r) => r.subdomain)
      .filter((s): s is string => typeof s === 'string'),
  );

  for (;;) {
    // Drives still missing a publishSubdomain, paginated by id.
    const missing = await (dbInstance as typeof defaultDb)
      .select({ id: drives.id, slug: drives.slug, publishSubdomain: drives.publishSubdomain })
      .from(drives)
      .where(and(isNull(drives.publishSubdomain), gt(drives.id, cursor)))
      .orderBy(asc(drives.id))
      .limit(BATCH_SIZE);

    if (missing.length === 0) break;

    const assignments = computePublishSubdomainBackfill(missing, [...taken]);

    if (dryRun) {
      allocated += assignments.length;
      console.log(`  would allocate ${assignments.length} subdomains (cursor: ${cursor || '<start>'})`);
    } else {
      for (const a of assignments) {
        try {
          await (dbInstance as typeof defaultDb)
            .update(drives)
            .set({ publishSubdomain: a.subdomain })
            .where(eq(drives.id, a.driveId));
          allocated += 1;
          taken.add(a.subdomain); // keep within-run set current so later batches de-dupe
        } catch (err) {
          // Race: another writer claimed this exact subdomain between our read and write.
          // Skip it — a re-run will assign it the next free suffix. Never relax uniqueness.
          const code = (err as { code?: string })?.code;
          if (code === '23505') {
            skipped += 1;
            console.warn(`  ⚠️  collision on "${a.subdomain}" for drive ${a.driveId} — skipped`);
          } else {
            throw err;
          }
        }
      }
    }

    cursor = missing[missing.length - 1].id;
    if (missing.length < BATCH_SIZE) break;
  }

  console.log(
    `✅ Backfill ${dryRun ? 'dry run ' : ''}complete. ${dryRun ? `would allocate: ${allocated}` : `allocated: ${allocated}, skipped (collisions): ${skipped}`}`,
  );

  return { allocated, skipped };
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
