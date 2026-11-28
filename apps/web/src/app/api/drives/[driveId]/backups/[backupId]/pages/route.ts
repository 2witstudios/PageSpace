import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';
import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveBackups, driveBackupPages, pageVersions } from '@pagespace/db/schema/versioning';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

import { readPageContent } from '@pagespace/lib/services/page-content-store';
import { buildSnapshotPageTree } from '@/services/api/snapshot-pages-service';
import { gateBackupRows } from '@/services/api/backup-sign-in-gate';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };
const CONCURRENCY_CAP = 10;

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; backupId: string }> },
) {
  const { driveId, backupId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const isAdmin = await isPrincipalDriveOwnerOrAdmin(auth, driveId);
  if (!isAdmin) {
    return deniedResponse(actorFromAuth(auth), driveId, NextResponse.json({ error: 'Access denied' }, { status: 403 }));
  }

  const backup = await db.query.driveBackups.findFirst({
    where: eq(driveBackups.id, backupId),
  });

  if (!backup || backup.driveId !== driveId) {
    return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
  }

  const snapshotRows = await db
    .select({
      pageId: driveBackupPages.pageId,
      title: driveBackupPages.title,
      type: driveBackupPages.type,
      parentId: driveBackupPages.parentId,
      position: driveBackupPages.position,
      isTrashed: driveBackupPages.isTrashed,
      stateHash: pageVersions.stateHash,
      contentRef: pageVersions.contentRef,
    })
    .from(driveBackupPages)
    .leftJoin(pageVersions, eq(driveBackupPages.pageVersionId, pageVersions.id))
    .where(eq(driveBackupPages.backupId, backupId));

  // SEC-2/3 (D-OW-62): the preview is a read by this credential, whoever took the backup.
  const { rows: pageRows, withheld } = await gateBackupRows(actorFromAuth(auth), backup.metadata, snapshotRows);

  const url = new URL(request.url);
  const includeContent = url.searchParams.get('includeContent') === 'true';
  const filterPageId = url.searchParams.get('pageId') ?? null;

  type RowWithContent = (typeof pageRows)[number] & { content?: string };
  const rowsWithContent: RowWithContent[] = pageRows.map(r => ({ ...r }));

  if (includeContent) {
    // When a specific pageId is requested, only fetch content for that page to
    // avoid loading the entire drive's content on every row click in the UI.
    const rowsToFetch = filterPageId
      ? rowsWithContent.filter(r => r.pageId === filterPageId)
      : rowsWithContent;

    const queue = [...rowsToFetch];
    const workers = Array.from({ length: Math.min(CONCURRENCY_CAP, queue.length) }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) continue;
        if (!row.contentRef) continue;
        try {
          row.content = await readPageContent(row.contentRef);
        } catch {
          // S3 failure — omit content for this page
        }
      }
    });
    await Promise.all(workers);
  }

  const pages = buildSnapshotPageTree(rowsWithContent);
  return NextResponse.json({
    backup: {
      id: backup.id,
      label: backup.label,
      source: backup.source,
      status: backup.status,
      createdAt: backup.createdAt,
    },
    pages,
    withheld,
  });
}
