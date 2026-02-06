import { db, pages, drives, driveMembers, eq, and } from '@pagespace/db';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { getActorInfo } from '@pagespace/lib/server';
import { applyPageMutation } from './page-mutation-service';

/**
 * Result types for page reorder operations
 */
export interface ReorderSuccess {
  success: true;
  driveId: string;
  pageTitle: string | null;
}

export interface ReorderError {
  success: false;
  error: string;
  status: number;
}

export type ReorderResult = ReorderSuccess | ReorderError;

export interface ReorderParams {
  pageId: string;
  newParentId: string | null;
  newPosition: number;
  userId: string;
}

/**
 * Page reorder service - encapsulates all DB operations for page reordering
 * This is the boundary seam that route tests should mock
 */
export const pageReorderService = {
  /**
   * Validate that a page move won't create a circular reference
   */
  async validateMove(pageId: string, newParentId: string | null): Promise<{ valid: boolean; error?: string }> {
    return validatePageMove(pageId, newParentId);
  },

  /**
   * Execute a page reorder operation
   * Handles authorization, validation, and the actual move in a transaction
   */
  async reorderPage(params: ReorderParams): Promise<ReorderResult> {
    const { pageId, newParentId, newPosition, userId } = params;

    let driveId: string | null = null;
    let pageTitle: string | null = null;

    try {
      // Get the page and its drive info
      const [pageInfo] = await db
        .select({
          driveId: pages.driveId,
          title: pages.title,
          ownerId: drives.ownerId,
          revision: pages.revision,
        })
        .from(pages)
        .leftJoin(drives, eq(pages.driveId, drives.id))
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!pageInfo) {
        return { success: false, error: 'Page not found.', status: 404 };
      }

      driveId = pageInfo.driveId;
      pageTitle = pageInfo.title;

      if (!pageInfo.ownerId || !driveId) {
        return { success: false, error: 'Drive not found for page.', status: 404 };
      }

      // Check authorization: user must be owner or admin
      const isOwner = pageInfo.ownerId === userId;
      let isAdmin = false;

      if (!isOwner && driveId) {
        const adminMembership = await db
          .select()
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, driveId),
            eq(driveMembers.userId, userId),
            eq(driveMembers.role, 'ADMIN')
          ))
          .limit(1);

        isAdmin = adminMembership.length > 0;
      }

      if (!isOwner && !isAdmin) {
        return { success: false, error: 'Only drive owners and admins can reorder pages.', status: 403 };
      }

      // Validate parent page if specified
      if (newParentId) {
        const [parentPage] = await db
          .select({ driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, newParentId))
          .limit(1);

        if (!parentPage) {
          return { success: false, error: 'Parent page not found.', status: 404 };
        }

        if (parentPage.driveId !== driveId) {
          return { success: false, error: 'Cannot move pages between different drives.', status: 400 };
        }
      }

      const actorInfo = await getActorInfo(userId);
      await applyPageMutation({
        pageId,
        operation: 'move',
        updates: {
          parentId: newParentId,
          position: newPosition,
        },
        updatedFields: ['parentId', 'position'],
        expectedRevision: pageInfo.revision,
        context: {
          userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
        },
      });

      return {
        success: true,
        driveId: driveId!,
        pageTitle,
      };
    } catch (error) {
      // Handle structured errors from transaction
      if (error && typeof error === 'object' && 'status' in error && 'message' in error) {
        const structuredError = error as { message: string; status: number };
        return {
          success: false,
          error: structuredError.message,
          status: structuredError.status,
        };
      }

      // Re-throw unexpected errors
      throw error;
    }
  },
};
