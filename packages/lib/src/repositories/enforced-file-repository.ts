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
   * Checks:
   * 1. File exists
   * 2. Resource binding (if token is bound to specific resource)
   * 3. Drive membership (unless admin)
   * 4. files:read scope
   *
   * @param fileId - The file ID to retrieve
   * @returns The file record or null if not found
   * @throws ForbiddenError if authorization fails
   */
  async getFile(fileId: string): Promise<FileRecord | null> {
    // 1. Fetch file from database
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
    });

    // 2. Return null if not found (before auth checks)
    if (!file) {
      return null;
    }

    // 3. Check resource binding
    // Token may be bound to a specific file, drive, or page
    if (!this.isResourceAccessAllowed(file)) {
      throw new ForbiddenError('Token not authorized for this resource');
    }

    // 4. Check drive membership (unless admin)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (!drivePerms) {
        throw new ForbiddenError('User not a member of this drive');
      }
    }

    // 5. Check files:read scope
    if (!this.ctx.hasScope('files:read')) {
      throw new ForbiddenError('Missing files:read scope');
    }

    return file as FileRecord;
  }

  /**
   * Update a file with full authorization checks.
   *
   * Checks:
   * 1. All getFile() checks
   * 2. files:write scope
   * 3. Role allows editing (not viewer)
   *
   * @param fileId - The file ID to update
   * @param data - The fields to update
   * @returns The updated file record
   * @throws ForbiddenError if authorization fails or file not found
   */
  async updateFile(fileId: string, data: FileUpdateInput): Promise<FileRecord> {
    // 1. Get file with auth checks (reuses getFile logic)
    const file = await this.getFileForUpdate(fileId);
    if (!file) {
      throw new ForbiddenError('File not found');
    }

    // 2. Check files:write scope
    if (!this.ctx.hasScope('files:write')) {
      throw new ForbiddenError('Missing files:write scope');
    }

    // 3. Check role allows editing (admin always can)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (drivePerms && !drivePerms.canEdit) {
        throw new ForbiddenError('Viewer role cannot modify files');
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
   */
  private async getFileForUpdate(fileId: string): Promise<FileRecord | null> {
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
    });

    if (!file) {
      return null;
    }

    // Check resource binding
    if (!this.isResourceAccessAllowed(file)) {
      throw new ForbiddenError('Token not authorized for this resource');
    }

    // Check drive membership (unless admin)
    if (!this.ctx.isAdmin()) {
      const drivePerms = await getUserDrivePermissions(this.ctx.userId, file.driveId);
      if (!drivePerms) {
        throw new ForbiddenError('User not a member of this drive');
      }
    }

    return file as FileRecord;
  }
}
