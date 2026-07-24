import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { validateAdminAccess } from '@/lib/auth/admin-role';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  getUserStorageQuota,
  getUserFileCount,
  reconcileStorageUsage,
  STORAGE_TIERS,
  formatBytes
} from '@pagespace/lib/services/storage-limits';
import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db'
import { eq, or, inArray } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core';
import { findUserFileRows } from '@/lib/storage/storage-info-repository';
import {
  buildFileTypeBreakdown,
  pickLargestFiles,
  pickRecentFiles,
  buildStorageByDrive,
} from '@/lib/storage/storage-info-core';

export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve admin status UP FRONT — independent of the user-supplied reconcile
    // flag — so the privileged reconcile is gated on a verified authorization
    // result rather than on user-controlled request data (avoids the
    // user-controlled-bypass pattern). The session role short-circuits the DB
    // validation for non-admins, so normal storage-info reads incur no extra read
    // and emit no security logs. `validateAdminAccess` re-checks role +
    // adminRoleVersion against the DB to reject stale/revoked admin sessions.
    const isAdmin = user.role === 'admin'
      && (await validateAdminAccess(user.id, user.adminRoleVersion)).isValid;

    // Reconcile rewrites stored usage from a recomputed total; admin-gate it as
    // defense-in-depth (H4) on top of the accounting-basis fix. The gate is the
    // non-user-controlled `isAdmin`; the request param only selects the operation.
    const { searchParams } = new URL(request.url);
    const shouldReconcile = searchParams.get('reconcile') === 'true';

    if (shouldReconcile) {
      if (!isAdmin) {
        return NextResponse.json(
          { error: 'Forbidden: admin access required to reconcile storage' },
          { status: 403 },
        );
      }
      try {
        const reconcileResult = await reconcileStorageUsage(user.id);
        console.log(`Storage reconciled for user ${user.id}:`, reconcileResult);
      } catch (error) {
        console.error('Storage reconciliation failed:', error);
      }
    }

    // Get user's storage quota
    const quota = await getUserStorageQuota(user.id);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Get file count
    const fileCount = await getUserFileCount(user.id);

    // The charge basis: files.sizeBytes for files this user created, joined to
    // a representative page for display. Matches what quota/reconcile read, so
    // this surface never disagrees with the number that blocks an upload.
    const userFiles = await findUserFileRows(user.id);

    // Drives to show in the by-drive breakdown: every drive the user OWNS
    // (even at 0 bytes, so the table stays a complete inventory) UNION every
    // drive a referenced file actually lives in. userFiles includes files
    // created in ANY drive the user has upload access to, not just owned
    // ones (#2225 review) — without the union, a shared-drive upload's bytes
    // would count toward the total but be invisible in this breakdown.
    // Union both driveId (the blob's creation drive, for byte attribution) and
    // pageDriveId (the representative page's own drive, for the title/id
    // access check below — these can differ under cross-drive dedup).
    const referencedDriveIds = Array.from(
      new Set(
        userFiles
          .flatMap(f => [f.driveId, f.pageDriveId])
          .filter((id): id is string => id !== null),
      ),
    );
    const driveWhere = referencedDriveIds.length > 0
      ? or(eq(drives.ownerId, user.id), inArray(drives.id, referencedDriveIds))
      : eq(drives.ownerId, user.id);
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const candidateDrives = await db.query.drives.findMany({
      where: driveWhere,
      columns: { id: true, name: true, ownerId: true }
    });

    // #2225 review: a referenced (non-owned) drive can be one the user
    // uploaded into and was LATER REMOVED from — files.createdBy survives
    // membership changes, but the drive's metadata (name) must not keep
    // leaking to a user who no longer has access. Owned drives always pass
    // trivially; only re-check the ones the user doesn't own.
    const accessChecks = await Promise.all(
      candidateDrives.map(d => d.ownerId === user.id ? Promise.resolve(true) : getUserDriveAccess(user.id, d.id)),
    );
    const userDrives = candidateDrives.filter((_, i) => accessChecks[i]);

    const fileTypeBreakdown = buildFileTypeBreakdown(userFiles);

    // #2225 review: files.createdBy survives drive-membership removal, so the
    // representative page's title/id must not be shown once the user has lost
    // access to THAT page's drive (pageDriveId, not files.driveId — they can
    // differ under cross-drive dedup). Reuses the same access-checked drive
    // set as storageByDrive; a page in an inaccessible drive falls back to the
    // same fileId/"Untitled file" placeholder already used for DM attachments.
    const accessibleDriveIds = new Set(userDrives.map(d => d.id));
    const canShowPage = (f: { pageDriveId: string | null }) =>
      f.pageDriveId !== null && accessibleDriveIds.has(f.pageDriveId);

    const largestFiles = pickLargestFiles(userFiles, 10).map(f => ({
      id: canShowPage(f) ? f.pageId! : f.fileId,
      title: canShowPage(f) ? f.title! : 'Untitled file',
      mimeType: f.mimeType,
      formattedSize: formatBytes(f.sizeBytes)
    }));

    const recentFiles = pickRecentFiles(userFiles, 10).map(f => ({
      id: canShowPage(f) ? f.pageId! : f.fileId,
      title: canShowPage(f) ? f.title! : 'Untitled file',
      mimeType: f.mimeType,
      createdAt: f.createdAt,
      formattedSize: formatBytes(f.sizeBytes)
    }));

    const storageByDrive = buildStorageByDrive(userFiles, userDrives).map(d => ({
      ...d,
      formattedSize: formatBytes(d.totalSize)
    }));

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'storage', resourceId: user.id });

    return NextResponse.json({
      quota: {
        ...quota,
        formattedUsed: formatBytes(quota.usedBytes),
        formattedQuota: formatBytes(quota.quotaBytes),
        formattedAvailable: formatBytes(quota.availableBytes)
      },
      tierInfo: STORAGE_TIERS[quota.tier],
      fileCount,
      // `totalFiles` is shown beside tierInfo.maxFileCount in the UI, so it must
      // stay on the same basis checkStorageQuota enforces (getUserFileCount's
      // drive-scoped FILE-page count) — NOT userFiles.length, which counts
      // distinct blobs (files.createdBy) and would double under dedup (N pages
      // can share one blob) or diverge via attachments the file-count limit
      // doesn't gate.
      totalFiles: fileCount,
      fileTypeBreakdown,
      largestFiles,
      recentFiles,
      storageByDrive
    });

  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}