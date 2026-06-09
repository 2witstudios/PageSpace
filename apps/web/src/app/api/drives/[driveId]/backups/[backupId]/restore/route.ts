import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { driveBackups, driveBackupPermissions, driveBackupMembers, driveBackupRoles } from '@pagespace/db/schema/versioning';
import { pagePermissions, driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring/change-group';
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
    const changeGroupType = inferChangeGroupType({ isAiGenerated: false });

    // 5. Restore transaction
    const counts = await db.transaction(async tx => {
      const diffResult = await fetchAndComputeRestoreDiff(backupId, driveId, tx as never);
      if (!diffResult.ok) throw new Error(`Failed to compute diff: ${diffResult.reason}`);
      const { diff, backupPageMap } = diffResult;

      // Include unchanged pages so their ACLs are also replaced — page hashes
      // don't capture permissions, so a page with unchanged content can still
      // have stale ACLs from after the backup was taken.
      const affectedPageIds = [
        ...diff.toCreate.map(p => p.pageId),
        ...diff.toOverwrite.map(p => p.pageId),
        ...diff.toOrphan.map(p => p.pageId),
        ...diff.unchanged.map(p => p.pageId),
      ];

      // Fetch backup and current perm/member/role data in parallel before applying writes
      const [
        backupPermRows,
        backupMemberRows,
        backupRoleRows,
        currentPermRows,
        currentMemberRows,
        currentRoleRows,
      ] = await Promise.all([
        tx.select({
          pageId: driveBackupPermissions.pageId,
          userId: driveBackupPermissions.userId,
          canView: driveBackupPermissions.canView,
          canEdit: driveBackupPermissions.canEdit,
          canShare: driveBackupPermissions.canShare,
          canDelete: driveBackupPermissions.canDelete,
          grantedBy: driveBackupPermissions.grantedBy,
          note: driveBackupPermissions.note,
          expiresAt: driveBackupPermissions.expiresAt,
        }).from(driveBackupPermissions).where(eq(driveBackupPermissions.backupId, backupId)),
        tx.select({
          userId: driveBackupMembers.userId,
          role: driveBackupMembers.role,
          customRoleId: driveBackupMembers.customRoleId,
          invitedBy: driveBackupMembers.invitedBy,
          invitedAt: driveBackupMembers.invitedAt,
          acceptedAt: driveBackupMembers.acceptedAt,
        }).from(driveBackupMembers).where(eq(driveBackupMembers.backupId, backupId)),
        tx.select({
          roleId: driveBackupRoles.roleId,
          name: driveBackupRoles.name,
          description: driveBackupRoles.description,
          color: driveBackupRoles.color,
          isDefault: driveBackupRoles.isDefault,
          permissions: driveBackupRoles.permissions,
          driveWidePermissions: driveBackupRoles.driveWidePermissions,
          position: driveBackupRoles.position,
        }).from(driveBackupRoles).where(eq(driveBackupRoles.backupId, backupId)),
        affectedPageIds.length > 0
          ? tx.select({ pageId: pagePermissions.pageId, userId: pagePermissions.userId })
              .from(pagePermissions)
              .where(inArray(pagePermissions.pageId, affectedPageIds))
          : Promise.resolve([] as { pageId: string; userId: string }[]),
        tx.select({ userId: driveMembers.userId }).from(driveMembers).where(eq(driveMembers.driveId, driveId)),
        tx.select({ roleId: driveRoles.id }).from(driveRoles).where(eq(driveRoles.driveId, driveId)),
      ]);

      const ops = planPageRestoreOps(diff, backupPageMap);
      await applyPageRestoreOps(ops, driveId, auth.userId, backupId, changeGroupId, changeGroupType, tx as never);

      const permOps = planPermissionRestoreOps(backupPermRows as never[], currentPermRows, affectedPageIds);
      const memberOps = planMemberRestoreOps(backupMemberRows as never[], currentMemberRows);
      const roleOps = planRoleRestoreOps(backupRoleRows as never[], currentRoleRows);

      const { skippedMembers, skippedPermissions } = await applyPermRestoreOps(
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
        skippedPermissions,
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
