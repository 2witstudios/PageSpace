import { db } from '@pagespace/db/db'
import { eq, and, inArray, isNotNull, not, desc, sql } from '@pagespace/db/operators'
import { drives, pages } from '@pagespace/db/schema/core'
import type { PageTypeEnum } from '@pagespace/db/schema/core'
import { pagePermissions, driveMembers, driveRoles } from '@pagespace/db/schema/members'
import { files } from '@pagespace/db/schema/storage'
import { driveBackups, driveBackupPages, driveBackupPermissions, driveBackupMembers, driveBackupRoles, driveBackupFiles, pageVersions } from '@pagespace/db/schema/versioning';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import { computePageStateHash, createPageVersion } from '@pagespace/lib/services/page-version-service'
import { readPageContent } from '@pagespace/lib/services/page-content-store'
import { hashWithPrefix } from '@pagespace/lib/utils/hash-utils';
import { detectPageContentFormat } from '@pagespace/lib/content/page-content-format';

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

export type DriveBackupWithDriveName = DriveBackupSummary & { driveName: string | null; driveSlug: string | null };

export interface DriveBackupPage {
  pageId: string;
  title: string | null;
  type: string | null;
  parentId: string | null;
  position: number | null;
  isTrashed: boolean;
}

export interface DriveBackupDetail extends DriveBackupSummary {
  driveName: string | null;
  driveSlug: string | null;
  pages: DriveBackupPage[];
  members: { userId: string; role: string | null }[];
  roles: { roleId: string; name: string | null }[];
  files: { fileId: string; mimeType: string | null; sizeBytes: number | null }[];
}

export interface RestoreDriveBackupResult {
  success: boolean;
  preRestoreBackupId?: string;
  restoredPages?: number;
  error?: string;
  status?: number;
}

export async function listAllUserBackups(
  userId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ success: boolean; backups: DriveBackupWithDriveName[]; total: number; error?: string }> {
  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)));

  const adminMemberships = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .innerJoin(drives, and(eq(driveMembers.driveId, drives.id), eq(drives.isTrashed, false)))
    .where(and(
      eq(driveMembers.userId, userId),
      eq(driveMembers.role, 'ADMIN'),
      isNotNull(driveMembers.acceptedAt)
    ));

  const driveIds = [
    ...ownedDrives.map((d) => d.id),
    ...adminMemberships.map((d) => d.driveId),
  ];

  if (driveIds.length === 0) {
    return { success: true, backups: [], total: 0 };
  }

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const [rows, countRows] = await Promise.all([
    db
      .select({ backup: driveBackups, driveName: drives.name, driveSlug: drives.slug })
      .from(driveBackups)
      .innerJoin(drives, eq(driveBackups.driveId, drives.id))
      .where(inArray(driveBackups.driveId, driveIds))
      .orderBy(desc(driveBackups.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driveBackups)
      .where(inArray(driveBackups.driveId, driveIds)),
  ]);

  return {
    success: true,
    total: countRows[0]?.count ?? 0,
    backups: rows.map((r) => ({
      id: r.backup.id,
      driveId: r.backup.driveId,
      createdAt: r.backup.createdAt,
      createdBy: r.backup.createdBy,
      source: r.backup.source as DriveBackupSource,
      status: r.backup.status as DriveBackupSummary['status'],
      label: r.backup.label,
      reason: r.backup.reason,
      completedAt: r.backup.completedAt,
      failedAt: r.backup.failedAt,
      failureReason: r.backup.failureReason,
      driveName: r.driveName,
      driveSlug: r.driveSlug,
    })),
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
    // Create backup record first to get the ID
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

    try {
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
        status: 'ready' as const,
        counts: {
          pages: pagesToBackup.length,
          permissions: permissionCount,
          members: members.length,
          roles: roles.length,
          files: driveFiles.length,
        },
      };
    } catch (error) {
      // Mark backup as failed and return error result (don't throw - that would rollback the transaction)
      const failureReason = error instanceof Error ? error.message : 'Unknown error';
      await tx
        .update(driveBackups)
        .set({
          status: 'failed',
          failedAt: new Date(),
          failureReason,
        })
        .where(eq(driveBackups.id, backup.id));

      return {
        success: false,
        backupId: backup.id,
        status: 'failed' as const,
        error: failureReason,
      };
    }
  });
}

export async function getDriveBackupDetail(
  backupId: string,
  driveId: string,
  userId: string,
): Promise<{ success: boolean; detail?: DriveBackupDetail; error?: string; status?: number }> {
  const canManage = await isDriveOwnerOrAdmin(userId, driveId);
  if (!canManage) {
    return { success: false, error: 'Only drive owners and admins can view backups', status: 403 };
  }

  const [backup] = await db
    .select({ backup: driveBackups, driveName: drives.name, driveSlug: drives.slug })
    .from(driveBackups)
    .innerJoin(drives, eq(driveBackups.driveId, drives.id))
    .where(and(eq(driveBackups.id, backupId), eq(driveBackups.driveId, driveId)));

  if (!backup) {
    return { success: false, error: 'Backup not found', status: 404 };
  }

  const [bPages, bMembers, bRoles, bFiles] = await Promise.all([
    db.select().from(driveBackupPages).where(eq(driveBackupPages.backupId, backupId)),
    db.select().from(driveBackupMembers).where(eq(driveBackupMembers.backupId, backupId)),
    db.select().from(driveBackupRoles).where(eq(driveBackupRoles.backupId, backupId)),
    db.select().from(driveBackupFiles).where(eq(driveBackupFiles.backupId, backupId)),
  ]);

  return {
    success: true,
    detail: {
      id: backup.backup.id,
      driveId: backup.backup.driveId,
      createdAt: backup.backup.createdAt,
      createdBy: backup.backup.createdBy,
      source: backup.backup.source as DriveBackupSource,
      status: backup.backup.status as DriveBackupSummary['status'],
      label: backup.backup.label,
      reason: backup.backup.reason,
      completedAt: backup.backup.completedAt,
      failedAt: backup.backup.failedAt,
      failureReason: backup.backup.failureReason,
      driveName: backup.driveName,
      driveSlug: backup.driveSlug,
      pages: bPages.map((p) => ({
        pageId: p.pageId,
        title: p.title,
        type: p.type,
        parentId: p.parentId,
        position: p.position,
        isTrashed: p.isTrashed,
      })),
      members: bMembers.map((m) => ({ userId: m.userId, role: m.role })),
      roles: bRoles.map((r) => ({ roleId: r.roleId, name: r.name })),
      files: bFiles.map((f) => ({ fileId: f.fileId, mimeType: f.mimeType, sizeBytes: f.sizeBytes })),
    },
  };
}

export async function restoreDriveToBackup(
  backupId: string,
  driveId: string,
  userId: string,
): Promise<RestoreDriveBackupResult> {
  const canManage = await isDriveOwnerOrAdmin(userId, driveId);
  if (!canManage) {
    return { success: false, error: 'Only drive owners and admins can restore backups', status: 403 };
  }

  const [backup] = await db
    .select()
    .from(driveBackups)
    .where(and(eq(driveBackups.id, backupId), eq(driveBackups.driveId, driveId)));

  if (!backup) return { success: false, error: 'Backup not found', status: 404 };
  if (backup.status !== 'ready') return { success: false, error: 'Backup is not ready', status: 400 };

  // Always snapshot current state before overwriting
  const preRestore = await createDriveBackup(driveId, userId, {
    source: 'pre_restore',
    reason: `Pre-restore snapshot before restoring backup ${backupId}`,
  });
  if (!preRestore.success) {
    return { success: false, error: 'Failed to create pre-restore backup', status: 500 };
  }

  return db.transaction(async (tx) => {
    const [bPages, bMembers, bRoles, bPermissions] = await Promise.all([
      tx.select().from(driveBackupPages).where(eq(driveBackupPages.backupId, backupId)),
      tx.select().from(driveBackupMembers).where(eq(driveBackupMembers.backupId, backupId)),
      tx.select().from(driveBackupRoles).where(eq(driveBackupRoles.backupId, backupId)),
      tx.select().from(driveBackupPermissions).where(eq(driveBackupPermissions.backupId, backupId)),
    ]);

    const currentPages = await tx
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    const currentPageIds = new Set(currentPages.map((p) => p.id));
    const backupPageIds = new Set(bPages.map((p) => p.pageId));

    // Fetch content for pages that have a version reference
    const versionIds = bPages.flatMap((p) => p.pageVersionId ? [p.pageVersionId] : []);
    const contentByVersionId = new Map<string, string>();

    if (versionIds.length > 0) {
      const versions = await tx
        .select({ id: pageVersions.id, contentRef: pageVersions.contentRef })
        .from(pageVersions)
        .where(inArray(pageVersions.id, versionIds));

      await Promise.all(
        versions.map(async (v) => {
          if (!v.contentRef) return;
          try {
            const content = await readPageContent(v.contentRef);
            contentByVersionId.set(v.id, content);
          } catch {
            // Version content expired — restore structure only
          }
        })
      );
    }

    // Restore each backed-up page
    for (const bp of bPages) {
      const content = bp.pageVersionId ? (contentByVersionId.get(bp.pageVersionId) ?? '') : '';
      const commonFields = {
        title: bp.title ?? 'Untitled',
        parentId: bp.parentId,
        originalParentId: bp.originalParentId,
        position: bp.position ?? 0,
        isTrashed: bp.isTrashed,
        trashedAt: bp.trashedAt,
        content,
      };

      if (currentPageIds.has(bp.pageId)) {
        await tx
          .update(pages)
          .set({ ...commonFields, revision: sql`revision + 1` })
          .where(and(eq(pages.id, bp.pageId), eq(pages.driveId, driveId)));
      } else {
        await tx.insert(pages).values({
          id: bp.pageId,
          driveId,
          type: (bp.type ?? 'DOCUMENT') as PageTypeEnum,
          revision: 0,
          ...commonFields,
        });
      }
    }

    // Trash pages that exist now but were not in the backup
    const idsToTrash = [...currentPageIds].filter((id) => !backupPageIds.has(id));
    if (idsToTrash.length > 0) {
      await tx
        .update(pages)
        .set({ isTrashed: true, trashedAt: new Date() })
        .where(and(eq(pages.driveId, driveId), inArray(pages.id, idsToTrash)));
    }

    // Restore page permissions: drop current, insert backup
    if (bPermissions.length > 0) {
      const affectedPageIds = [...new Set(bPermissions.map((p) => p.pageId))];
      await tx.delete(pagePermissions).where(inArray(pagePermissions.pageId, affectedPageIds));
      await tx.insert(pagePermissions).values(
        bPermissions.map((p) => ({
          pageId: p.pageId,
          userId: p.userId,
          canView: p.canView,
          canEdit: p.canEdit,
          canShare: p.canShare,
          canDelete: p.canDelete,
          grantedBy: p.grantedBy,
          note: p.note,
          expiresAt: p.expiresAt,
        }))
      );
    }

    // Restore drive members
    await tx.delete(driveMembers).where(eq(driveMembers.driveId, driveId));
    if (bMembers.length > 0) {
      await tx.insert(driveMembers).values(
        bMembers.map((m) => ({
          driveId,
          userId: m.userId,
          role: (m.role ?? 'MEMBER') as 'OWNER' | 'ADMIN' | 'MEMBER',
          customRoleId: m.customRoleId,
          invitedBy: m.invitedBy,
          invitedAt: m.invitedAt ?? new Date(),
          acceptedAt: m.acceptedAt,
        }))
      );
    }

    // Restore custom roles
    await tx.delete(driveRoles).where(eq(driveRoles.driveId, driveId));
    if (bRoles.length > 0) {
      await tx.insert(driveRoles).values(
        bRoles.map((r) => ({
          id: r.roleId,
          driveId,
          name: r.name ?? 'Untitled Role',
          description: r.description,
          color: r.color,
          isDefault: r.isDefault,
          permissions: (r.permissions ?? {}) as Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>,
          position: Math.round(r.position ?? 0),
        }))
      );
    }

    return {
      success: true,
      preRestoreBackupId: preRestore.backupId,
      restoredPages: bPages.length,
    };
  });
}
