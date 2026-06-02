import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { inArray, sql } from '@pagespace/db/operators';

/**
 * Repair pages orphaned by past non-cascading trashes.
 *
 * Historically, trashing a page did NOT trash its children by default — it left
 * them pointing at the now-trashed parent. Because the sidebar fetches only
 * non-trashed pages and buildTree promotes any node whose parent is absent to the
 * root, those live descendants surfaced as bogus top-level items.
 *
 * Trashing now cascades by default, so no NEW orphans are created. This script
 * fixes pre-existing ones by making the data consistent: any live page whose
 * parent (transitively) is trashed is itself moved to the trash — exactly what
 * would have happened had the original trash cascaded. parentId is left intact, so
 * restoring the original trashed ancestor recursively brings the whole branch back.
 *
 * Pages deliberately re-homed via the "move children up" option are NOT affected:
 * their parent is a live grandparent, so they are never matched here.
 *
 * Dry run (default — reports only, no writes):
 *   bun scripts/repair-orphaned-trashed-pages.ts
 * Apply the fix:
 *   bun scripts/repair-orphaned-trashed-pages.ts --apply
 * In Docker:
 *   docker exec <container> bun scripts/repair-orphaned-trashed-pages.ts --apply
 */
async function repair(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`Scanning for live pages stranded under a trashed ancestor... (${apply ? 'APPLY' : 'dry run'})`);

  // Live descendants of any trashed page: seed with live children of trashed
  // pages, then walk down through further live descendants.
  const orphanRows = await db.execute<{ id: string; driveId: string; title: string }>(sql`
    WITH RECURSIVE orphans AS (
      SELECT child.id, child."driveId", child.title
      FROM pages child
      JOIN pages parent ON child."parentId" = parent.id
      WHERE child."isTrashed" = false
        AND parent."isTrashed" = true

      UNION

      SELECT child.id, child."driveId", child.title
      FROM pages child
      JOIN orphans o ON child."parentId" = o.id
      WHERE child."isTrashed" = false
    )
    SELECT id, "driveId", title FROM orphans;
  `);

  const orphans = orphanRows.rows;
  console.log(`Found ${orphans.length} stranded page(s).`);

  if (orphans.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  // Per-drive breakdown for visibility before any writes.
  const byDrive = new Map<string, number>();
  for (const o of orphans) byDrive.set(o.driveId, (byDrive.get(o.driveId) ?? 0) + 1);
  for (const [driveId, count] of byDrive) {
    console.log(`  drive ${driveId}: ${count} page(s)`);
  }

  if (!apply) {
    console.log('\nDry run only — no changes made. Re-run with --apply to trash these pages.');
    console.log('Sample:', orphans.slice(0, 10).map(o => `${o.title} (${o.id})`));
    return;
  }

  const ids = orphans.map(o => o.id);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(pages)
      .set({ isTrashed: true, trashedAt: now })
      .where(inArray(pages.id, ids));
  });

  console.log(`\nTrashed ${ids.length} stranded page(s). Restoring the original trashed ancestor will bring them back.`);
}

repair()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Repair failed:', error);
    process.exit(1);
  });
