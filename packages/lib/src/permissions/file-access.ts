/**
 * File Access Authorization
 *
 * Files linked to pages via `filePages` require page-level access (canUserViewPage)
 * for at least one linked page. Files with no page linkages fall back to drive
 * membership check (isUserDriveMember).
 *
 * This closes the gap where files attached to restricted pages could be accessed
 * by any drive member via direct URL.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { filePages } from '@pagespace/db/schema/storage';
import { canUserViewPage, isUserDriveMember } from './permissions';

/**
 * Check if a user can access a file.
 *
 * Authorization logic:
 * 1. Look up page linkages via `filePages`
 * 2. If linkages exist: require canUserViewPage for at least one linked page
 * 3. If no linkages: fall back to isUserDriveMember for the file's drive
 */
export async function canUserAccessFile(
  userId: string,
  fileId: string,
  driveId: string
): Promise<boolean> {
  const linkedPages = await db
    .select({ pageId: filePages.pageId })
    .from(filePages)
    .where(eq(filePages.fileId, fileId));

  if (linkedPages.length > 0) {
    for (const { pageId } of linkedPages) {
      const hasAccess = await canUserViewPage(userId, pageId);
      if (hasAccess) return true;
    }
    return false;
  }

  return isUserDriveMember(userId, driveId);
}
