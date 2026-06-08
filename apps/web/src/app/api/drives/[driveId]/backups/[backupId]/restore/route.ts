import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveBackups } from '@pagespace/db/schema/versioning';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { fetchAndComputeRestoreDiff } from '@/services/api/restore-diff-service';
import { planPageRestoreOps, applyPageRestoreOps } from '@/services/api/restore-pages-service';
import {
  planPermissionRestoreOps,
  planMemberRestoreOps,
  planRoleRestoreOps,
  applyPermRestoreOps,
} from '@/services/api/restore-permissions-service';
import { runPreRestoreSnapshot } from '@/services/api/restore-backup-service';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string; backupId: string }> },
) {
  const { driveId, backupId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    // 1. Permission check
    const isAdmin = await isDriveOwnerOrAdmin(auth.userId, driveId);
    if (!isAdmin) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // 2. Load and validate backup
    const backup = await db.query.driveBackups.findFirst({
      where: eq(driveBackups.id, backupId),
    });

    if (!backup || backup.driveId !== driveId) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 400 });
    }

    // 3. Backup must be ready
    if (backup.status !== 'ready') {
      return NextResponse.json({ error: 'Backup is not in a ready state' }, { status: 409 });
    }

    // 4. Pre-restore snapshot (outside transaction — must survive even if restore rolls back)
    const snapshot = await runPreRestoreSnapshot(driveId, auth.userId, backupId);
    if (!snapshot.success) {
      loggers.api.error('Pre-restore snapshot failed', new Error(snapshot.error));
      return NextResponse.json(
        { error: 'Pre-restore snapshot failed before restore could begin' },
        { status: 500 },
      );
    }

    const changeGroupId = createChangeGroupId();

    // 5. Restore transaction
    const counts = await db.transaction(async tx => {
      const diffResult = await fetchAndComputeRestoreDiff(backupId, driveId, tx as never);
      if (!diffResult.ok) throw new Error('Failed to compute diff');
      const { diff, backupPageMap } = diffResult;

      // Load current members and roles for planning (permissions fetched empty — restored from backup tables)
      const [currentMemberRows, currentRoleRows] =
        await Promise.all([
          tx.select({ userId: driveMembers.userId }).from(driveMembers).where(eq(driveMembers.driveId, driveId)),
          tx.select({ roleId: driveRoles.id }).from(driveRoles).where(eq(driveRoles.driveId, driveId)),
        ]);
      const currentPermRows: never[] = [];

      const ops = planPageRestoreOps(diff, backupPageMap);
      await applyPageRestoreOps(ops, driveId, auth.userId, backupId, changeGroupId, tx as never);

      const affectedPageIds = [
        ...diff.toCreate.map(p => p.pageId),
        ...diff.toOverwrite.map(p => p.pageId),
        ...diff.toOrphan.map(p => p.pageId),
      ];

      const permOps = planPermissionRestoreOps([], currentPermRows as never[], affectedPageIds);
      const memberOps = planMemberRestoreOps([], currentMemberRows as never[]);
      const roleOps = planRoleRestoreOps([], currentRoleRows as never[]);

      const { skippedMembers } = await applyPermRestoreOps(
        permOps,
        memberOps,
        roleOps,
        driveId,
        tx as never,
      );

      return {
        pagesCreated: diff.toCreate.length,
        pagesOverwritten: diff.toOverwrite.length,
        pagesOrphaned: diff.toOrphan.length,
        skippedMembers,
      };
    });

    // 6. Audit
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'restore_backup', backupId },
    });

    return NextResponse.json({
      preRestoreBackupId: snapshot.preRestoreBackupId,
      counts,
    });
  } catch (error) {
    loggers.api.error('Restore failed', error as Error);
    return NextResponse.json({ error: 'Restore failed — drive is unchanged' }, { status: 500 });
  }
}
