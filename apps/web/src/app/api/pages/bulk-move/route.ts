import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { and, eq, inArray, desc, isNull } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core'
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult, isScopedMCPAuth, canPrincipalEditPage } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { syncTaskItemOnMove } from '@/services/api/task-sync-service';
import { syncPublishedHomeRoot } from '@/lib/canvas/publish-page';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  targetDriveId: z.string().min(1, 'Target drive ID is required'),
  targetParentId: z.string().nullable(),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();

    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const { pageIds, targetDriveId, targetParentId } = parseResult.data;

    // Verify target drive exists
    const targetDrive = await db.query.drives.findFirst({
      where: eq(drives.id, targetDriveId),
    });

    if (!targetDrive) {
      return NextResponse.json({ error: 'Target drive not found' }, { status: 404 });
    }

    // Check MCP token scope for target drive
    const targetScopeError = checkMCPDriveScope(auth, targetDriveId);
    if (targetScopeError) {
      return targetScopeError;
    }

    // Check the principal has edit access to target drive. A scoped MCP token
    // is its own drive member — use the TOKEN's role, not its owning user's.
    let canEditDrive: boolean;
    const tokenMembership = isScopedMCPAuth(auth)
      ? await getAppDriveMembership(auth.tokenId, targetDriveId)
      : null;
    if (isScopedMCPAuth(auth) && tokenMembership?.role !== null) {
      // Explicit-role keys need OWNER/ADMIN; inherited keys (role null) fall
      // through to the owner's own authority below.
      canEditDrive = tokenMembership?.role === 'OWNER' || tokenMembership?.role === 'ADMIN';
    } else {
      // isDriveOwnerOrAdmin is the centralized owner-or-accepted-admin gate
      // (packages/lib/src/permissions/permissions.ts) — pending invitees
      // (acceptedAt IS NULL) are excluded, so a pending ADMIN cannot write
      // into a drive they have not accepted into.
      canEditDrive = await isDriveOwnerOrAdmin(userId, targetDriveId);
    }

    if (!canEditDrive) {
      return NextResponse.json(
        { error: 'You do not have permission to move pages to this drive' },
        { status: 403 }
      );
    }

    // Verify target parent exists if specified
    if (targetParentId) {
      const targetParent = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, targetParentId),
          eq(pages.driveId, targetDriveId),
          eq(pages.isTrashed, false)
        ),
      });
      if (!targetParent) {
        return NextResponse.json({ error: 'Target folder not found' }, { status: 404 });
      }
    }

    // Check user has edit access to all source pages
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const sourcePages = await db.query.pages.findMany({
      where: inArray(pages.id, pageIds),
    });

    if (sourcePages.length !== pageIds.length) {
      return NextResponse.json({ error: 'Some pages not found' }, { status: 404 });
    }

    // Check MCP token scope for all source pages
    const allowedDriveIds = getAllowedDriveIds(auth);
    if (allowedDriveIds.length > 0) {
      const allowedSet = new Set(allowedDriveIds);
      for (const page of sourcePages) {
        if (!allowedSet.has(page.driveId)) {
          return NextResponse.json(
            { error: 'This token does not have access to one or more source pages' },
            { status: 403 }
          );
        }
      }
    }

    // Verify edit permissions for all pages
    for (const page of sourcePages) {
      const canEdit = await canPrincipalEditPage(auth, page.id);
      if (!canEdit) {
        return NextResponse.json(
          { error: `You do not have permission to move page: ${page.title}` },
          { status: 403 }
        );
      }
    }

    // Validate move doesn't create circular references
    for (const pageId of pageIds) {
      if (targetParentId) {
        const validation = await validatePageMove(pageId, targetParentId);
        if (!validation.valid) {
          return NextResponse.json({ error: validation.error }, { status: 400 });
        }
      }
    }

    // Get the max position in target parent
    const lastPage = await db.query.pages.findFirst({
      where: and(
        eq(pages.driveId, targetDriveId),
        targetParentId ? eq(pages.parentId, targetParentId) : isNull(pages.parentId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [desc(pages.position)],
    });

    let nextPosition = (lastPage?.position || 0) + 1;

    // Track affected drives for broadcast events
    const affectedDriveIds = new Set<string>();
    affectedDriveIds.add(targetDriveId);

    // Drives whose homePageId was cleared during the move (synced after tx commits).
    const clearedHomePageDriveIds: string[] = [];

    // Move pages in transaction
    await db.transaction(async (tx) => {
      for (const page of sourcePages) {
        const sourceDriveId = page.driveId;
        affectedDriveIds.add(sourceDriveId);

        // Update page with new drive, parent, and position
        await tx.update(pages)
          .set({
            driveId: targetDriveId,
            parentId: targetParentId,
            position: nextPosition,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // If moving to a different drive, recursively update all children's driveId
        if (page.driveId !== targetDriveId) {
          await updateChildrenDriveId(tx, page.id, targetDriveId);
        }

        await syncTaskItemOnMove(tx, {
          movedPageId: page.id,
          movedPageType: page.type,
          oldParentId: page.parentId,
          newParentId: targetParentId,
          userId,
        });

        nextPosition += 1;
      }

      // A drive's home page must live in that drive. Clearing here (after the
      // moves, same transaction) also covers home pages that left as
      // descendants of a moved subtree via updateChildrenDriveId.
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
          await tx.update(drives)
            .set({ homePageId: null })
            .where(eq(drives.id, sourceDriveId));
          clearedHomePageDriveIds.push(sourceDriveId);
        }
      }
    });

    // Log activity for each moved page
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    const changeGroupId = createChangeGroupId();
    for (const page of sourcePages) {
      logPageActivity(userId, 'move', {
        id: page.id,
        title: page.title ?? undefined,
        driveId: targetDriveId,
      }, {
        ...actorInfo,
        changeGroupId,
        changeGroupType: 'user',
        updatedFields: ['driveId', 'parentId', 'position'],
        previousValues: { driveId: page.driveId, parentId: page.parentId },
        newValues: { driveId: targetDriveId, parentId: targetParentId },
        metadata: {
          bulkOperation: 'move',
          totalPages: pageIds.length,
          ...(isMCP && { source: 'mcp' }),
        },
      });
    }

    // Broadcast events
    for (const driveId of affectedDriveIds) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, '', 'moved')
      );
    }

    // Sync the subdomain root for drives whose home page was bulk-moved away.
    // Fire-and-forget: never blocks the response; syncPublishedHomeRoot swallows errors.
    for (const driveId of clearedHomePageDriveIds) {
      void syncPublishedHomeRoot(driveId);
    }

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page', resourceId: 'bulk', details: { operation: 'bulk_move', count: pageIds.length } });

    return NextResponse.json({
      success: true,
      movedCount: pageIds.length,
    });
  } catch (error) {
    loggers.api.error('Error bulk moving pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to move pages' },
      { status: 500 }
    );
  }
}

// Recursively update driveId for all children
async function updateChildrenDriveId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: string,
  newDriveId: string
) {
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const children = await tx.query.pages.findMany({
    where: eq(pages.parentId, parentId),
  });

  for (const child of children) {
    await tx.update(pages)
      .set({ driveId: newDriveId })
      .where(eq(pages.id, child.id));

    // Recursively update grandchildren
    await updateChildrenDriveId(tx, child.id, newDriveId);
  }
}
