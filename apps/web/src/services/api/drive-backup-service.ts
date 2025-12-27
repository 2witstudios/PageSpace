import {
  db,
  pages,
  driveBackups,
  driveBackupPages,
  driveBackupPermissions,
  driveBackupMembers,
  driveBackupRoles,
  driveBackupFiles,
  pagePermissions,
  driveMembers,
  driveRoles,
  files,
  eq,
  inArray,
  desc,
} from '@pagespace/db';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/server';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring';
import { computePageStateHash, createPageVersion, hashWithPrefix } from '@pagespace/lib/server';
import { detectPageContentFormat } from '@pagespace/lib/content';

export type DriveBackupSource = 'manual' | 'scheduled' | 'pre_restore' | 'system';

type DriveBackupPageInsert = typeof driveBackupPages.$inferInsert;

export interface CreateDriveBackupInput {
  label?: string;
  reason?: string;
  source?: DriveBackupSource;
  includeTrashed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DriveBackupSummary {
  id: string;
  driveId: string;
  createdAt: Date;
  createdBy: string | null;
  source: DriveBackupSource;
  status: 'pending' | 'ready' | 'failed';
  label: string | null;
  reason: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
}

export interface CreateDriveBackupResult {
  success: boolean;
  backupId?: string;
  status?: 'ready' | 'failed';
  error?: string;
  counts?: {
    pages: number;
    permissions: number;
    members: number;
    roles: number;
    files: number;
  };
}

export async function listDriveBackups(
  driveId: string,
  userId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ success: boolean; backups: DriveBackupSummary[]; error?: string; status?: number }> {
  const canManage = await isDriveOwnerOrAdmin(userId, driveId);
  if (!canManage) {
    return { success: false, backups: [], error: 'Only drive owners and admins can view backups', status: 403 };
  }

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const backups = await db
    .select()
    .from(driveBackups)
    .where(eq(driveBackups.driveId, driveId))
    .orderBy(desc(driveBackups.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    success: true,
    backups: backups.map((backup) => ({
      id: backup.id,
      driveId: backup.driveId,
      createdAt: backup.createdAt,
      createdBy: backup.createdBy,
      source: backup.source as DriveBackupSource,
      status: backup.status,
      label: backup.label,
      reason: backup.reason,
      completedAt: backup.completedAt,
      failedAt: backup.failedAt,
      failureReason: backup.failureReason,
    })),
  };
}

export async function createDriveBackup(
  driveId: string,
  userId: string,
  input: CreateDriveBackupInput = {}
): Promise<CreateDriveBackupResult> {
  const canManage = await isDriveOwnerOrAdmin(userId, driveId);
  if (!canManage) {
    return { success: false, error: 'Only drive owners and admins can create backups' };
  }

  const includeTrashed = input.includeTrashed ?? true;
  const changeGroupId = createChangeGroupId();
  const changeGroupType = inferChangeGroupType({ isAiGenerated: false });

  return db.transaction(async (tx) => {
    const [backup] = await tx
      .insert(driveBackups)
      .values({
        driveId,
        createdBy: userId,
        source: input.source ?? 'manual',
        status: 'pending',
        label: input.label,
        reason: input.reason,
        changeGroupId,
        changeGroupType,
        metadata: input.metadata,
      })
      .returning({ id: driveBackups.id });

    const drivePages = await tx
      .select()
      .from(pages)
      .where(eq(pages.driveId, driveId));

    const pagesToBackup = includeTrashed
      ? drivePages
      : drivePages.filter((page) => !page.isTrashed);

    // Prepare page data for version creation
    const pageVersionData = pagesToBackup.map((page) => {
      const content = page.content ?? '';
      const contentFormat = detectPageContentFormat(content);
      const contentRef = hashWithPrefix(contentFormat, content);
      const stateHash = page.stateHash ?? computePageStateHash({
        title: page.title,
        contentRef,
        parentId: page.parentId,
        position: page.position,
        isTrashed: page.isTrashed,
        type: page.type,
        driveId: page.driveId,
        aiProvider: page.aiProvider,
        aiModel: page.aiModel,
        systemPrompt: page.systemPrompt,
        enabledTools: page.enabledTools,
        isPaginated: page.isPaginated,
        includeDrivePrompt: page.includeDrivePrompt,
        agentDefinition: page.agentDefinition,
        visibleToGlobalAssistant: page.visibleToGlobalAssistant,
        includePageTree: page.includePageTree,
        pageTreeScope: page.pageTreeScope,
      });
      return { page, content, contentFormat, stateHash };
    });

    // Create page versions in batches for better performance
    const versionBatchSize = 50;
    const backupPageRows: DriveBackupPageInsert[] = [];

    for (let i = 0; i < pageVersionData.length; i += versionBatchSize) {
      const batch = pageVersionData.slice(i, i + versionBatchSize);
      const versionPromises = batch.map(({ page, content, contentFormat, stateHash }) =>
        createPageVersion({
          pageId: page.id,
          driveId: page.driveId,
          createdBy: userId,
          source: 'system',
          content,
          contentFormat,
          pageRevision: page.revision,
          stateHash,
          changeGroupId,
          changeGroupType,
          metadata: { backupId: backup.id },
        }, { tx })
      );

      const versions = await Promise.all(versionPromises);

      versions.forEach((version, idx) => {
        const { page } = batch[idx];
        backupPageRows.push({
          backupId: backup.id,
          pageId: page.id,
          pageVersionId: version.id,
          title: page.title,
          type: page.type,
          parentId: page.parentId,
          originalParentId: page.originalParentId,
          position: page.position,
          isTrashed: page.isTrashed,
          trashedAt: page.trashedAt,
        });
      });
    }

    const backupPageBatchSize = 250;
    for (let i = 0; i < backupPageRows.length; i += backupPageBatchSize) {
      await tx.insert(driveBackupPages).values(
        backupPageRows.slice(i, i + backupPageBatchSize)
      );
    }

    const pageIds = pagesToBackup.map((page) => page.id);
    let permissionCount = 0;
    if (pageIds.length > 0) {
      const permissions = await tx
        .select()
        .from(pagePermissions)
        .where(inArray(pagePermissions.pageId, pageIds));

      permissionCount = permissions.length;
      if (permissions.length > 0) {
        await tx.insert(driveBackupPermissions).values(
          permissions.map((permission) => ({
            backupId: backup.id,
            pageId: permission.pageId,
            userId: permission.userId,
            canView: permission.canView,
            canEdit: permission.canEdit,
            canShare: permission.canShare,
            canDelete: permission.canDelete,
            grantedBy: permission.grantedBy,
            note: permission.note,
            expiresAt: permission.expiresAt,
          }))
        );
      }
    }

    const members = await tx
      .select()
      .from(driveMembers)
      .where(eq(driveMembers.driveId, driveId));

    if (members.length > 0) {
      await tx.insert(driveBackupMembers).values(
        members.map((member) => ({
          backupId: backup.id,
          userId: member.userId,
          role: member.role,
          customRoleId: member.customRoleId,
          invitedBy: member.invitedBy,
          invitedAt: member.invitedAt,
          acceptedAt: member.acceptedAt,
        }))
      );
    }

    const roles = await tx
      .select()
      .from(driveRoles)
      .where(eq(driveRoles.driveId, driveId));

    if (roles.length > 0) {
      await tx.insert(driveBackupRoles).values(
        roles.map((role) => ({
          backupId: backup.id,
          roleId: role.id,
          name: role.name,
          description: role.description,
          color: role.color,
          isDefault: role.isDefault,
          permissions: role.permissions,
          position: role.position,
        }))
      );
    }

    const driveFiles = await tx
      .select()
      .from(files)
      .where(eq(files.driveId, driveId));

    if (driveFiles.length > 0) {
      const backupFileRows = driveFiles.map((file) => ({
          backupId: backup.id,
          fileId: file.id,
          storagePath: file.storagePath,
          // sizeBytes is already numeric due to bigint mode mapping.
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          checksumVersion: file.checksumVersion,
        }));
      const backupFileBatchSize = 250;
      for (let i = 0; i < backupFileRows.length; i += backupFileBatchSize) {
        await tx.insert(driveBackupFiles).values(
          backupFileRows.slice(i, i + backupFileBatchSize)
        );
      }
    }

    await tx
      .update(driveBackups)
      .set({
        status: 'ready',
        completedAt: new Date(),
      })
      .where(eq(driveBackups.id, backup.id));

    return {
      success: true,
      backupId: backup.id,
      status: 'ready',
      counts: {
        pages: pagesToBackup.length,
        permissions: permissionCount,
        members: members.length,
        roles: roles.length,
        files: driveFiles.length,
      },
    };
  });
}
