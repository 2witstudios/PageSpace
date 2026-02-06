import { getUserAccessLevel } from '@pagespace/lib/permissions-cached';
import { getLinksForFile } from './file-links';

export type AccessRequirement = 'view' | 'edit';

export interface FileAccessResult {
  allowed: boolean;
  pageId?: string;
  driveId?: string;
}

export async function checkFileAccess(
  userId: string,
  contentHash: string,
  requirement: AccessRequirement
): Promise<FileAccessResult> {
  const links = await getLinksForFile(contentHash);
  if (links.length === 0) {
    return { allowed: false };
  }

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

  return { allowed: false };
}

export async function assertFileAccess(
  userId: string,
  contentHash: string,
  requirement: AccessRequirement
): Promise<void> {
  const result = await checkFileAccess(userId, contentHash, requirement);
  if (!result.allowed) {
    const action = requirement === 'edit' ? 'modify' : 'view';
    const error = new Error(`User ${userId} is not authorized to ${action} file`);
    error.name = 'AuthorizationError';
    throw error;
  }
}
