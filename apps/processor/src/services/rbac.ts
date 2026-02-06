import { getUserAccessLevel } from '@pagespace/lib/permissions-cached';
import { getLinksForFile } from './file-links';
import { db, files, eq } from '@pagespace/db';

export type AccessRequirement = 'view' | 'edit';

export interface FileAccessResult {
  allowed: boolean;
  pageId?: string;
  driveId?: string;
}

export interface FileAccessOptions {
  authDriveId?: string;
}

export async function checkFileAccess(
  userId: string,
  contentHash: string,
  requirement: AccessRequirement,
  options?: FileAccessOptions
): Promise<FileAccessResult> {
  // Check page-level permissions via filePages links
  const links = await getLinksForFile(contentHash);

  for (const link of links) {
    const perms = await getUserAccessLevel(userId, link.pageId);
    if (!perms) {
      continue;
    }

    if (requirement === 'view' && perms.canView) {
      return { allowed: true, pageId: link.pageId, driveId: link.driveId };
    }

    if (requirement === 'edit' && (perms.canEdit || perms.canShare)) {
      return { allowed: true, pageId: link.pageId, driveId: link.driveId };
    }
  }

  // Fallback: check drive-level access for files without page links (e.g. channel attachments).
  // The auth token's driveId claim means the web app already verified drive membership.
  // We just need to confirm the file actually belongs to that drive.
  if (requirement === 'view' && options?.authDriveId) {
    const fileRecord = await db.query.files.findFirst({
      where: eq(files.id, contentHash),
      columns: { driveId: true },
    });

    if (fileRecord && fileRecord.driveId === options.authDriveId) {
      return { allowed: true, driveId: fileRecord.driveId };
    }
  }

  return { allowed: false };
}

export async function assertFileAccess(
  userId: string,
  contentHash: string,
  requirement: AccessRequirement,
  options?: FileAccessOptions
): Promise<void> {
  const result = await checkFileAccess(userId, contentHash, requirement, options);
  if (!result.allowed) {
    const action = requirement === 'edit' ? 'modify' : 'view';
    const error = new Error(`User ${userId} is not authorized to ${action} file`);
    error.name = 'AuthorizationError';
    throw error;
  }
}
