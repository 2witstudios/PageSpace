/**
 * page-cross-drive-move-service — the ONE implementation of "move pages (and their
 * subtrees) into another drive".
 *
 * Extracted from POST /api/pages/bulk-move so the REST route and the AI `move_page`
 * tool share the same validation order, the same transaction, the same descendant
 * cascade, the same home-page invariant and the same activity trail. Before this
 * seam existed the tool simply could not move across drives, and any second
 * implementation would have had to re-derive a dozen ordering decisions.
 *
 * Principal-agnostic via an INJECTED authorizer rather than a pure core plus two
 * wrappers: the three authorization questions are interleaved with reads the
 * service must do anyway (you cannot ask "may you administer the destination"
 * before confirming it exists, nor "may you edit each source page" before loading
 * the rows whose `title` the 403 message embeds). Three closures at the call site
 * is the smallest interface that keeps ordering, short-circuiting and error copy
 * in one place.
 *
 * Side effects the two callers present differently — websocket broadcast and
 * `syncPublishedHomeRoot` — are NOT fired here. They are driven by the caller off
 * the returned `affectedDriveIds` / `clearedHomePageDriveIds`.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, desc, isNull } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import {
  findProtectedMemoryPages,
  MEMORY_PAGE_MOVE_ERROR,
} from '@pagespace/lib/memory/memory-pages';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { syncTaskItemOnMove, scrubDriveScopedTaskAssociations } from '@/services/api/task-sync-service';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Depth ceiling for the descendant cascade — the number of descendant LEVELS
 * below the moved roots that will be rewritten. Chosen to match MAX_DEPTH in
 * circular-reference-guard, which bounds the ancestor walk the same way.
 *
 * The guard exists to stop a parentId cycle, not to reject deep trees: it fires
 * only when a level beyond the ceiling still has unvisited nodes, so a subtree
 * exactly MAX_SUBTREE_DEPTH levels deep migrates in full rather than being
 * rolled back after every one of its nodes was already written.
 */
export const MAX_SUBTREE_DEPTH = 100;

/**
 * The three authorization questions a cross-drive move asks, in the order the
 * service asks them. Callers supply the primitives: the REST route closes over
 * `canPrincipalEditPage` / its drive owner-admin block, the AI tool over
 * `canActorEditPage` / `canActorManageDrive`. The service owns the ORDER, the
 * failure codes and the user-facing copy — that is the drift this seam prevents.
 */
export interface CrossDriveMoveAuthorizer {
  /** Deny-only MCP/app-token drive-scope ceiling. A no-op for unscoped callers. */
  isDriveInScope(driveId: string): boolean | Promise<boolean>;
  /** Owner/admin on the DESTINATION drive. Never asked about a source drive. */
  canAdministerDrive(driveId: string): Promise<boolean>;
  /** Edit access on ONE source page. Called once per source page, in order. */
  canEditPage(pageId: string): Promise<boolean>;
}

export interface CrossDriveMoveActivity {
  isAiGenerated?: boolean;
  aiProvider?: string;
  aiModel?: string;
  aiConversationId?: string;
  changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
  /** Merged into each activity row's metadata. */
  metadata?: Record<string, unknown>;
}

export interface CrossDriveMoveParams {
  pageIds: string[];
  targetDriveId: string;
  targetParentId: string | null;
  /** The human behind the action, agent or not — used for activity attribution. */
  userId: string;
  authorize: CrossDriveMoveAuthorizer;
  activity?: CrossDriveMoveActivity;
}

export type CrossDriveMoveFailureCode =
  | 'TARGET_DRIVE_NOT_FOUND'
  | 'TARGET_DRIVE_OUT_OF_SCOPE'
  | 'TARGET_DRIVE_FORBIDDEN'
  | 'TARGET_PARENT_NOT_FOUND'
  | 'SOURCE_PAGES_NOT_FOUND'
  | 'SOURCE_DRIVE_OUT_OF_SCOPE'
  | 'SOURCE_PAGE_FORBIDDEN'
  | 'CIRCULAR_REFERENCE'
  | 'MEMORY_PAGE_PROTECTED'
  | 'SUBTREE_TOO_DEEP';

export interface MovedPageSummary {
  id: string;
  title: string | null;
  previousDriveId: string;
  previousParentId: string | null;
  position: number;
}

export type CrossDriveMoveResult =
  | {
      success: true;
      moved: MovedPageSummary[];
      /** How many DESCENDANT rows had their driveId rewritten. */
      descendantCount: number;
      /** Every drive needing a `moved` broadcast — the target plus all sources. */
      affectedDriveIds: string[];
      /** Drives whose homePageId was nulled; caller fires syncPublishedHomeRoot. */
      clearedHomePageDriveIds: string[];
    }
  | {
      success: false;
      code: CrossDriveMoveFailureCode;
      status: 400 | 403 | 404;
      message: string;
    };

/** Internal signal: the cascade hit MAX_SUBTREE_DEPTH (almost certainly a parentId cycle). */
class PageSubtreeTooDeepError extends Error {}

function fail(
  code: CrossDriveMoveFailureCode,
  status: 400 | 403 | 404,
  message: string,
): CrossDriveMoveResult {
  return { success: false, code, status, message };
}

/**
 * Rewrite `driveId` on every descendant of `rootIds`, level by level.
 *
 * Iterative with a visited set and a depth cap, NOT recursive: `pages.parentId`
 * carries no self-FK, so a cycle is representable — and the previous recursive
 * version would have looped forever holding an open transaction. The visited set
 * is seeded with the roots so a root that is itself a descendant of another root
 * is never re-driven.
 *
 * Trashed descendants are deliberately included: a trashed child left behind
 * would restore into a drive its parent has already left.
 */
async function cascadeDriveIdToDescendants(
  tx: Tx,
  rootIds: string[],
  newDriveId: string,
): Promise<string[]> {
  const visited = new Set(rootIds);
  let frontier = rootIds;
  const moved: string[] = [];

  for (let depth = 0; frontier.length > 0; depth++) {
    // eslint-disable-next-line no-restricted-syntax -- level-wise tree walk, bounded by MAX_SUBTREE_DEPTH; a LIMIT would silently drop descendants and split the subtree across drives
    const children = await tx.query.pages.findMany({
      where: inArray(pages.parentId, frontier),
      // ids only: this runs inside the open write transaction, and `pages`
      // carries unbounded `content` plus several jsonb columns. Selecting whole
      // rows would drag a whole subtree's document bodies through the wire and
      // the heap while holding locks on the level above.
      columns: { id: true },
    });

    const next = children.map((child) => child.id).filter((id) => !visited.has(id));
    if (next.length === 0) break;

    // Checked only once a level actually HAS unvisited nodes, so a tree exactly
    // MAX_SUBTREE_DEPTH levels deep completes instead of being rolled back with
    // every node already rewritten.
    if (depth >= MAX_SUBTREE_DEPTH) {
      throw new PageSubtreeTooDeepError(
        `Page subtree exceeds ${MAX_SUBTREE_DEPTH} levels — possible circular reference`,
      );
    }

    next.forEach((id) => visited.add(id));
    await tx.update(pages).set({ driveId: newDriveId }).where(inArray(pages.id, next));
    moved.push(...next);
    frontier = next;
  }

  return moved;
}

export async function movePagesToDrive(
  params: CrossDriveMoveParams,
): Promise<CrossDriveMoveResult> {
  const { pageIds, targetDriveId, targetParentId, userId, authorize, activity } = params;

  const targetDrive = await db.query.drives.findFirst({
    where: eq(drives.id, targetDriveId),
    // Existence only — no column is read, and the full row carries drivePrompt.
    columns: { id: true },
  });
  if (!targetDrive) {
    return fail('TARGET_DRIVE_NOT_FOUND', 404, 'Target drive not found');
  }

  if (!(await authorize.isDriveInScope(targetDriveId))) {
    return fail(
      'TARGET_DRIVE_OUT_OF_SCOPE',
      403,
      'This token does not have access to the target drive',
    );
  }

  if (!(await authorize.canAdministerDrive(targetDriveId))) {
    return fail(
      'TARGET_DRIVE_FORBIDDEN',
      403,
      'You do not have permission to move pages to this drive',
    );
  }

  if (targetParentId) {
    const targetParent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, targetParentId),
        eq(pages.driveId, targetDriveId),
        eq(pages.isTrashed, false),
      ),
      columns: { id: true },
    });
    if (!targetParent) {
      return fail('TARGET_PARENT_NOT_FOUND', 404, 'Target folder not found');
    }
  }

  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const sourcePages = await db.query.pages.findMany({
    where: inArray(pages.id, pageIds),
    columns: { id: true, driveId: true, parentId: true, title: true, type: true },
  });
  if (sourcePages.length !== pageIds.length) {
    return fail('SOURCE_PAGES_NOT_FOUND', 404, 'Some pages not found');
  }

  for (const page of sourcePages) {
    if (!(await authorize.isDriveInScope(page.driveId))) {
      return fail(
        'SOURCE_DRIVE_OUT_OF_SCOPE',
        403,
        'This token does not have access to one or more source pages',
      );
    }
  }

  for (const page of sourcePages) {
    if (!(await authorize.canEditPage(page.id))) {
      return fail(
        'SOURCE_PAGE_FORBIDDEN',
        403,
        `You do not have permission to move page: ${page.title}`,
      );
    }
  }

  // Memory pages are addressed by pointer and assumed to live in the user's Home
  // drive; moving one to another drive breaks that and puts the user's profile
  // inside a drive they may later delete. Guarded HERE rather than at each
  // caller because this service is the only cross-drive move path, shared by
  // /api/pages/bulk-move and the AI move_page tool — pageService.updatePage's
  // guard never sees either. After the permission loops above, so a caller who
  // cannot move the page is not told what it is.
  const protectedIds = await findProtectedMemoryPages(pageIds);
  if (protectedIds.size > 0) {
    return fail('MEMORY_PAGE_PROTECTED', 403, MEMORY_PAGE_MOVE_ERROR);
  }

  if (targetParentId) {
    for (const pageId of pageIds) {
      const validation = await validatePageMove(pageId, targetParentId);
      if (!validation.valid) {
        return fail('CIRCULAR_REFERENCE', 400, validation.error);
      }
    }
  }

  const lastPage = await db.query.pages.findFirst({
    where: and(
      eq(pages.driveId, targetDriveId),
      targetParentId ? eq(pages.parentId, targetParentId) : isNull(pages.parentId),
      eq(pages.isTrashed, false),
    ),
    orderBy: [desc(pages.position)],
    columns: { position: true },
  });

  let nextPosition = (lastPage?.position || 0) + 1;

  const affectedDriveIds = new Set<string>([targetDriveId]);
  const clearedHomePageDriveIds: string[] = [];
  const moved: MovedPageSummary[] = [];
  let descendantCount = 0;

  try {
    await db.transaction(async (tx) => {
      const cascadeRoots: string[] = [];

      for (const page of sourcePages) {
        affectedDriveIds.add(page.driveId);

        await tx
          .update(pages)
          .set({
            driveId: targetDriveId,
            parentId: targetParentId,
            position: nextPosition,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        if (page.driveId !== targetDriveId) {
          cascadeRoots.push(page.id);
        }

        await syncTaskItemOnMove(tx, {
          movedPageId: page.id,
          movedPageType: page.type,
          oldParentId: page.parentId,
          newParentId: targetParentId,
          userId,
        });

        moved.push({
          id: page.id,
          title: page.title,
          previousDriveId: page.driveId,
          previousParentId: page.parentId,
          position: nextPosition,
        });

        nextPosition += 1;
      }

      if (cascadeRoots.length > 0) {
        const movedDescendants = await cascadeDriveIdToDescendants(tx, cascadeRoots, targetDriveId);
        descendantCount = movedDescendants.length;

        // The roots' membership change is handled by syncTaskItemOnMove above, but a
        // descendant's parentId never changes, so no membership event fires for it even
        // though its drive just did. Both need their drive-scoped task associations
        // dropped, or an agent assignee / workflow trigger from the old drive survives
        // the boundary.
        await scrubDriveScopedTaskAssociations(tx, {
          pageIds: [...cascadeRoots, ...movedDescendants],
          targetDriveId,
        });
      }

      // A drive's home page must live in that drive. Clearing here (after the
      // moves, same transaction) also covers home pages that left as
      // descendants of a moved subtree via the cascade above.
      const sourceDriveIds = [...affectedDriveIds].filter((id) => id !== targetDriveId);
      for (const sourceDriveId of sourceDriveIds) {
        const sourceDrive = await tx.query.drives.findFirst({
          where: eq(drives.id, sourceDriveId),
          columns: { homePageId: true },
        });
        if (!sourceDrive?.homePageId) continue;

        const homePageStillInDrive = await tx.query.pages.findFirst({
          where: and(eq(pages.id, sourceDrive.homePageId), eq(pages.driveId, sourceDriveId)),
          columns: { id: true },
        });
        if (!homePageStillInDrive) {
          await tx.update(drives).set({ homePageId: null }).where(eq(drives.id, sourceDriveId));
          clearedHomePageDriveIds.push(sourceDriveId);
        }
      }
    });
  } catch (error) {
    if (error instanceof PageSubtreeTooDeepError) {
      return fail('SUBTREE_TOO_DEEP', 400, error.message);
    }
    throw error;
  }

  const actorInfo = await getActorInfo(userId);
  const changeGroupId = createChangeGroupId();
  for (const page of moved) {
    logPageActivity(
      userId,
      'move',
      {
        id: page.id,
        title: page.title ?? undefined,
        driveId: targetDriveId,
      },
      {
        ...actorInfo,
        changeGroupId,
        changeGroupType: activity?.changeGroupType ?? 'user',
        isAiGenerated: activity?.isAiGenerated,
        aiProvider: activity?.aiProvider,
        aiModel: activity?.aiModel,
        aiConversationId: activity?.aiConversationId,
        updatedFields: ['driveId', 'parentId', 'position'],
        previousValues: { driveId: page.previousDriveId, parentId: page.previousParentId },
        newValues: { driveId: targetDriveId, parentId: targetParentId },
        metadata: { ...activity?.metadata },
      },
    );
  }

  return {
    success: true,
    moved,
    descendantCount,
    affectedDriveIds: [...affectedDriveIds],
    clearedHomePageDriveIds,
  };
}
