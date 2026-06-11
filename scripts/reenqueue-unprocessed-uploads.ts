import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { and, eq, sql } from '@pagespace/db/operators';
import { createUploadServiceToken } from '@pagespace/lib/services/validated-service-token';

/**
 * Re-enqueue processor ingestion for FILE pages whose post-upload enqueue was
 * silently dropped.
 *
 * Between the direct-to-S3 cutover (#1456, 2026-05-29) and the UPLOAD_SCOPES
 * fix, `/api/upload/complete` minted enqueue tokens without `files:ingest`,
 * so the processor rejected every `/api/ingest/pull` with 403 and the pages
 * stayed `processingStatus = 'pending'` with no derived content (thumbnails,
 * OCR, text extraction).
 *
 * Tokens are minted here directly (with the fixed scopes), so this can run
 * before the web deploy — it only needs DB access and a route to the
 * processor:
 *
 *   fly proxy 3003:3003 -a pagespace-processor   # in another terminal
 *   DATABASE_URL=<prod> PROCESSOR_URL=http://localhost:3003 \
 *     bun scripts/reenqueue-unprocessed-uploads.ts [--dry-run] [--since 2026-05-29]
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const DRY_RUN = process.argv.includes('--dry-run');
const sinceArgIdx = process.argv.indexOf('--since');
const SINCE = new Date(sinceArgIdx === -1 ? '2026-05-29T00:00:00Z' : process.argv[sinceArgIdx + 1]);

if (Number.isNaN(SINCE.getTime())) {
  console.error('Invalid --since date');
  process.exit(1);
}

async function enqueue(userId: string, driveId: string, pageId: string): Promise<void> {
  const { token } = await createUploadServiceToken({ userId, driveId, pageId });
  const res = await fetch(`${PROCESSOR_URL}/api/ingest/pull/${pageId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `Processor ingest failed with status ${res.status}`);
  }
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: pages.id,
      driveId: pages.driveId,
      createdBy: pages.createdBy,
      title: pages.title,
      createdAt: pages.createdAt,
      processingStatus: pages.processingStatus,
    })
    .from(pages)
    .where(
      and(
        eq(pages.type, 'FILE'),
        eq(pages.isTrashed, false),
        sql`${pages.processingStatus} IN ('pending', 'failed')`,
        sql`${pages.createdAt} >= ${SINCE.toISOString()}`,
        sql`${pages.filePath} IS NOT NULL`,
      ),
    );

  console.log(`Found ${rows.length} unprocessed FILE pages since ${SINCE.toISOString()}${DRY_RUN ? ' (dry run)' : ''}`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.createdBy) {
      // Token minting validates the user's edit permission; without a creator
      // there is no principal to mint for. Surface these for manual handling.
      console.warn(`SKIP ${row.id} "${row.title}" — no createdBy user`);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`WOULD ENQUEUE ${row.id} "${row.title}" (status=${row.processingStatus}, created=${row.createdAt?.toISOString()})`);
      ok += 1;
      continue;
    }

    try {
      await enqueue(row.createdBy, row.driveId, row.id);
      console.log(`ENQUEUED ${row.id} "${row.title}"`);
      ok += 1;
    } catch (err) {
      console.error(`FAILED ${row.id} "${row.title}":`, (err as Error).message);
      failed += 1;
    }
  }

  console.log(`Done: ${ok} enqueued, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
