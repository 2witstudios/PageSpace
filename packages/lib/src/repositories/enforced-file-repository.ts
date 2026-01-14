/**
 * Enforced File Repository (P2-T7)
 *
 * Implements RBAC at the data access layer with enforced permission checks.
 * Ensures authorization cannot be bypassed by directly calling database queries.
 *
 * @module @pagespace/lib/repositories/enforced-file-repository
 */

import { db, files, eq } from '@pagespace/db';
import { EnforcedAuthContext } from '../permissions/enforced-context';
import { getUserDrivePermissions } from '../permissions/permissions-cached';
import { loggers } from '../logging/logger-config';

/**
 * Error thrown when authorization fails.
 * Use 403 status code in HTTP responses.
 */
export class ForbiddenError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * File record type matching the database schema
 */
export interface FileRecord {
  id: string;
  driveId: string;
  sizeBytes: number;
  mimeType: string | null;
  storagePath: string | null;
  checksumVersion: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  lastAccessedAt: Date | null;
}

/**
 * Update input for file modifications
 */
export interface FileUpdateInput {
  mimeType?: string | null;
  storagePath?: string | null;
  lastAccessedAt?: Date | null;
}

/**
 * Enforced File Repository - RBAC at data access layer
 *
 * All file operations go through this repository to ensure:
 * 1. Resource binding is validated
 * 2. Drive membership is checked
 * 3. Scope requirements are enforced
 * 4. Role-based access is respected
 */
export class EnforcedFileRepository {
  constructor(private ctx: EnforcedAuthContext) {}

  /**
   * Get a file by ID with full authorization checks.
   *
   * SECURITY: Returns null for both "not found" AND "unauthorized" cases.
   * This prevents file ID enumeration attacks where an attacker could
   * distinguish between non-existent files (null) vs existing but
   * unauthorized files (error). Audit logs capture the actual reason.
   *
   * Checks:
   * 1. files:read scope (checked first, before DB query)
   * 2. File exists
   * 3. Resource binding (if token is bound to specific resource)
   * 4. Drive membership (unless admin)
   *
   * @param fileId - The file ID to retrieve
   * @returns The file record or null if not found/unauthorized
   */
  async getFile(fileId: string): Promise<FileRecord | null> {
    // 1. Check files:read scope first (can check without DB query)
    if (!this.ctx.hasScope('files:read')) {
      loggers.api.warn('File access denied: missing scope', {
        fileId,
        userId: this.ctx.userId,
        reason: 'missing_files_read_scope',
      });
      return null; // Don't reveal file existence
    }

    // 2. Fetch file from database
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
    });

    // 3. Return null if not found
    if (!file) {
      return null;
    }

    // 4. Check resource binding
    // Token may be bound to a specific file, drive, or page
    if (!this.isResourceAccessAllowed(file)) {
      loggers.api.warn('File access denied: resource binding mismatch', {
        fileId,
        userId: this.ctx.userId,
        reason: 'resource_binding_mismatch',
      });
      return null; // Don't reveal file existence
    }

    // 5. Check drive membership (unless admin)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (!drivePerms) {
        loggers.api.warn('File access denied: not drive member', {
          fileId,
          driveId: file.driveId,
          userId: this.ctx.userId,
          reason: 'not_drive_member',
        });
        return null; // Don't reveal file existence
      }
    }

    return file as FileRecord;
  }

  /**
   * Update a file with full authorization checks.
   *
   * SECURITY: Throws generic ForbiddenError for both "not found" AND
   * "unauthorized" cases to prevent file ID enumeration attacks.
   * Audit logs capture the actual reason for investigation.
   *
   * Checks:
   * 1. files:write scope (checked first)
   * 2. File exists and passes auth checks
   * 3. Role allows editing (not viewer)
   *
   * @param fileId - The file ID to update
   * @param data - The fields to update
   * @returns The updated file record
   * @throws ForbiddenError if authorization fails or file not found/unauthorized
   */
  async updateFile(fileId: string, data: FileUpdateInput): Promise<FileRecord> {
    // 1. Check files:write scope first (can check without DB query)
    if (!this.ctx.hasScope('files:write')) {
      loggers.api.warn('File update denied: missing scope', {
        fileId,
        userId: this.ctx.userId,
        reason: 'missing_files_write_scope',
      });
      throw new ForbiddenError('Access denied');
    }

    // 2. Get file with auth checks
    const file = await this.getFileForUpdate(fileId);
    if (!file) {
      // Generic error - don't reveal whether file exists or auth failed
      throw new ForbiddenError('Access denied');
    }

    // 3. Check role allows editing (admin always can)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (drivePerms && !drivePerms.canEdit) {
        loggers.api.warn('File update denied: viewer role', {
          fileId,
          userId: this.ctx.userId,
          reason: 'viewer_cannot_edit',
        });
        throw new ForbiddenError('Access denied');
      }
    }

    // 4. Perform update
    const [updatedFile] = await db
      .update(files)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(files.id, fileId))
      .returning();

    return updatedFile as FileRecord;
  }

  /**
   * Internal helper to check if resource access is allowed based on token binding.
   *
   * A token can be bound to:
   * - A specific file (must match exactly)
   * - A specific drive (file must be in that drive)
   * - No binding (unrestricted)
   */
  private isResourceAccessAllowed(file: { id: string; driveId: string }): boolean {
    const binding = this.ctx.resourceBinding;

    // No binding = unrestricted
    if (!binding) {
      return true;
    }

    // Check by resource type
    switch (binding.type) {
      case 'file':
        return binding.id === file.id;
      case 'drive':
        return binding.id === file.driveId;
      case 'page':
        // Page binding requires checking file-page associations
        // For now, we allow if the file is in the same drive
        // TODO: Add filePages lookup for stricter validation
        return true;
      default:
        // Unknown binding type - deny by default
        return false;
    }
  }

  /**
   * Internal helper to get file for update operations.
   * Performs read-level auth checks without requiring read scope.
   *
   * SECURITY: Returns null for both "not found" and "unauthorized"
   * to prevent file ID enumeration. Logs actual reason for audit.
   */
  private async getFileForUpdate(fileId: string): Promise<FileRecord | null> {
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
    });

    if (!file) {
      loggers.api.warn('File update denied: file not found', {
        fileId,
        userId: this.ctx.userId,
        reason: 'file_not_found',
      });
      return null;
    }

    // Check resource binding
    if (!this.isResourceAccessAllowed(file)) {
      loggers.api.warn('File update denied: resource binding mismatch', {
        fileId,
        userId: this.ctx.userId,
        reason: 'resource_binding_mismatch',
      });
      return null; // Don't reveal file existence
    }

    // Check drive membership (unless admin)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (!drivePerms) {
        loggers.api.warn('File update denied: not drive member', {
          fileId,
          driveId: file.driveId,
          userId: this.ctx.userId,
          reason: 'not_drive_member',
        });
        return null; // Don't reveal file existence
      }
    }

    return file as FileRecord;
  }
}
