import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { and, eq, sql } from '@pagespace/db/operators';
import {
  createUploadServiceToken,
  isPermissionDeniedError,
} from '@pagespace/lib/services/validated-service-token';

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

/**
 * Mint an enqueue token as the original uploader, falling back to the drive
 * owner. The uploader may have been removed or downgraded since the upload;
 * the page and blob still belong to the drive, and the owner always has edit.
 */
async function mintToken(createdBy: string | null, driveId: string, pageId: string): Promise<string> {
  if (createdBy) {
    try {
      const { token } = await createUploadServiceToken({ userId: createdBy, driveId, pageId });
      return token;
    } catch (err) {
      if (!isPermissionDeniedError(err)) throw err;
    }
  }

  const [drive] = await db
    .select({ ownerId: drives.ownerId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) throw new Error(`Drive ${driveId} not found`);

  const { token } = await createUploadServiceToken({ userId: drive.ownerId, driveId, pageId });
  return token;
}

async function enqueue(createdBy: string | null, driveId: string, pageId: string): Promise<void> {
  const token = await mintToken(createdBy, driveId, pageId);
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
        // Only 'pending' — that's the state the missing-scope bug leaves
        // behind. 'failed' means the processor actually ran and rejected the
        // file (hash mismatch, disallowed type — rejectAndFail deletes the
        // object), so re-enqueueing those can never succeed.
        eq(pages.processingStatus, 'pending'),
        sql`${pages.createdAt} >= ${SINCE.toISOString()}`,
        sql`${pages.filePath} IS NOT NULL`,
      ),
    );

  console.log(`Found ${rows.length} unprocessed FILE pages since ${SINCE.toISOString()}${DRY_RUN ? ' (dry run)' : ''}`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
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

  console.log(`Done: ${ok} enqueued, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
