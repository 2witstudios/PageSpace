/**
 * Utility functions for page versioning
 *
 * Handles creation of page snapshots for version history.
 */

import {
  db,
  pageVersions,
  pages,
  eq,
  max,
  desc,
  and,
  inArray,
} from '@pagespace/db';

export interface CreatePageVersionParams {
  pageId: string;
  auditEventId?: string;
  userId?: string;
  isAiGenerated?: boolean;
  changeSummary?: string;
  changeType?: 'minor' | 'major' | 'ai_edit' | 'user_edit';
}

/**
 * Creates a version snapshot of a page
 *
 * @param params - Version creation parameters
 * @returns The created page version
 *
 * @example
 * ```typescript
 * await createPageVersion({
 *   pageId: 'page123',
 *   auditEventId: 'audit456',
 *   userId: 'user789',
 *   changeSummary: 'Updated content',
 *   changeType: 'user_edit'
 * });
 * ```
 */
export async function createPageVersion(params: CreatePageVersionParams) {
  const {
    pageId,
    auditEventId,
    userId,
    isAiGenerated = false,
    changeSummary,
    changeType = 'minor',
  } = params;

  // Get current page state
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
  });

  if (!page) {
    throw new Error(`Page not found: ${pageId}`);
  }

  // Get next version number
  const maxVersionResult = await db
    .select({ max: max(pageVersions.versionNumber) })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId));

  const nextVersion = (maxVersionResult[0]?.max || 0) + 1;

  // Compute content size
  const contentSize = Buffer.byteLength(page.content || '', 'utf8');

  // Create version snapshot
  const [version] = await db
    .insert(pageVersions)
    .values({
      pageId,
      versionNumber: nextVersion,
      content: {
        content: page.content,
        // Store any other content-related fields
      },
      title: page.title,
      pageType: page.type,
      metadata: {
        aiProvider: page.aiProvider,
        aiModel: page.aiModel,
        systemPrompt: page.systemPrompt,
        enabledTools: page.enabledTools,
        // Store file-related metadata if present
        fileSize: page.fileSize,
        mimeType: page.mimeType,
        originalFileName: page.originalFileName,
      },
      auditEventId,
      createdBy: userId,
      isAiGenerated,
      contentSize,
      changeSummary,
      changeType,
      createdAt: new Date(),
    })
    .returning();

  return version;
}

/**
 * Gets all versions for a page
 *
 * @param pageId - Page ID
 * @param limit - Maximum number of versions to return (default: 100)
 * @returns Array of page versions, newest first
 */
export async function getPageVersions(pageId: string, limit = 100) {
  return await db.query.pageVersions.findMany({
    where: eq(pageVersions.pageId, pageId),
    orderBy: [desc(pageVersions.versionNumber)],
    limit,
    with: {
      createdByUser: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      auditEvent: {
        columns: {
          actionType: true,
          description: true,
          reason: true,
        },
      },
    },
  });
}

/**
 * Gets a specific version of a page
 *
 * @param pageId - Page ID
 * @param versionNumber - Version number
 * @returns The page version, or null if not found
 */
export async function getPageVersion(pageId: string, versionNumber: number) {
  return await db.query.pageVersions.findFirst({
    where: and(
      eq(pageVersions.pageId, pageId),
      eq(pageVersions.versionNumber, versionNumber)
    ),
    with: {
      createdByUser: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      auditEvent: true,
    },
  });
}

/**
 * Gets the latest version of a page
 *
 * @param pageId - Page ID
 * @returns The most recent page version, or null if no versions exist
 */
export async function getLatestPageVersion(pageId: string) {
  return await db.query.pageVersions.findFirst({
    where: eq(pageVersions.pageId, pageId),
    orderBy: [desc(pageVersions.versionNumber)],
    with: {
      createdByUser: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });
}

/**
 * Compares two page versions
 *
 * @param pageId - Page ID
 * @param fromVersion - Starting version number
 * @param toVersion - Ending version number
 * @returns Object with both versions for comparison
 */
export async function comparePageVersions(
  pageId: string,
  fromVersion: number,
  toVersion: number
) {
  const versions = await db.query.pageVersions.findMany({
    where: and(
      eq(pageVersions.pageId, pageId),
      inArray(pageVersions.versionNumber, [fromVersion, toVersion])
    ),
    orderBy: [desc(pageVersions.versionNumber)],
  });

  const from = versions.find((v) => v.versionNumber === fromVersion);
  const to = versions.find((v) => v.versionNumber === toVersion);

  if (!from || !to) {
    throw new Error(
      `Version not found. Requested: ${fromVersion} and ${toVersion}`
    );
  }

  return {
    from,
    to,
    // Client can compute diffs using these full snapshots
  };
}

/**
 * Restores a page to a previous version
 *
 * @param pageId - Page ID
 * @param versionNumber - Version to restore to
 * @param restoringUserId - User performing the restoration
 * @returns Updated page
 *
 * @example
 * ```typescript
 * const restoredPage = await restorePageVersion(
 *   'page123',
 *   5,
 *   'user789'
 * );
 * ```
 */
export async function restorePageVersion(
  pageId: string,
  versionNumber: number,
  restoringUserId: string
) {
  // Import audit utilities
  const { createAuditEvent } = await import('./create-audit-event');

  // Get the version to restore
  const version = await getPageVersion(pageId, versionNumber);

  if (!version) {
    throw new Error(
      `Version ${versionNumber} not found for page ${pageId}`
    );
  }

  // Get current page state
  const currentPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
  });

  if (!currentPage) {
    throw new Error(`Page not found: ${pageId}`);
  }

  // Extract content from version snapshot
  const restoredContent =
    typeof version.content === 'object' && version.content !== null
      ? (version.content as any).content || ''
      : '';

  // Update the page
  const [updatedPage] = await db
    .update(pages)
    .set({
      content: restoredContent,
      title: version.title,
      updatedAt: new Date(),
    })
    .where(eq(pages.id, pageId))
    .returning();

  // Create audit event for the restoration
  const auditEvent = await createAuditEvent({
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    entityId: pageId,
    userId: restoringUserId,
    driveId: currentPage.driveId,
    isAiAction: false,
    beforeState: {
      content: currentPage.content,
      title: currentPage.title,
    },
    afterState: {
      content: restoredContent,
      title: version.title,
    },
    changes: {
      content: {
        before: currentPage.content,
        after: restoredContent,
      },
      title: {
        before: currentPage.title,
        after: version.title,
      },
    },
    description: `Restored page to version ${versionNumber}`,
    reason: `User restored page to version ${versionNumber}`,
  });

  // Create new version for this restoration
  await createPageVersion({
    pageId,
    auditEventId: auditEvent.id,
    userId: restoringUserId,
    isAiGenerated: false,
    changeSummary: `Restored to version ${versionNumber}`,
    changeType: 'major',
  });

  return updatedPage;
}

/**
 * Gets version history metadata (counts, size, etc.)
 *
 * @param pageId - Page ID
 * @returns Version history statistics
 */
export async function getPageVersionStats(pageId: string) {
  const versions = await db.query.pageVersions.findMany({
    where: eq(pageVersions.pageId, pageId),
    columns: {
      versionNumber: true,
      contentSize: true,
      isAiGenerated: true,
      createdAt: true,
    },
  });

  const totalVersions = versions.length;
  const totalSize = versions.reduce(
    (sum, v) => sum + (v.contentSize || 0),
    0
  );
  const aiGeneratedCount = versions.filter(
    (v) => v.isAiGenerated
  ).length;
  const humanEditedCount = totalVersions - aiGeneratedCount;

  const oldestVersion = versions[versions.length - 1];
  const newestVersion = versions[0];

  return {
    totalVersions,
    totalSize,
    averageSize: totalVersions > 0 ? Math.round(totalSize / totalVersions) : 0,
    aiGeneratedCount,
    humanEditedCount,
    oldestVersionDate: oldestVersion?.createdAt,
    newestVersionDate: newestVersion?.createdAt,
  };
}
