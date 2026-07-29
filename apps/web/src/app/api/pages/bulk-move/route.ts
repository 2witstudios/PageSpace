import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { and, eq, isNotNull } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core'
import { driveMembers } from '@pagespace/db/schema/members';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult, isScopedMCPAuth, canPrincipalEditPage } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { movePagesToDrive } from '@/services/api/page-cross-drive-move-service';
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

    // Check MCP token scope for target drive. Stays in the route because it
    // returns the route's own NextResponse; the service's scope hook below
    // therefore only has the SOURCE drives left to gate.
    const targetScopeError = checkMCPDriveScope(auth, targetDriveId);
    if (targetScopeError) {
      return targetScopeError;
    }

    const allowedDriveIds = getAllowedDriveIds(auth);
    const allowedSet = allowedDriveIds.length > 0 ? new Set(allowedDriveIds) : null;

    const result = await movePagesToDrive({
      pageIds,
      targetDriveId,
      targetParentId,
      userId,
      authorize: {
        isDriveInScope: (driveId) =>
          // The target drive was already gated by checkMCPDriveScope above;
          // allowedDriveIds gates the source drives, exactly as before.
          driveId === targetDriveId || !allowedSet || allowedSet.has(driveId),

        // Check the principal has edit access to target drive. A scoped MCP token
        // is its own drive member — use the TOKEN's role, not its owning user's.
        canAdministerDrive: async (driveId) => {
          const targetDrive = await db.query.drives.findFirst({
            where: eq(drives.id, driveId),
            columns: { ownerId: true },
          });

          const tokenMembership = isScopedMCPAuth(auth)
            ? await getAppDriveMembership(auth.tokenId, driveId)
            : null;
          if (isScopedMCPAuth(auth) && tokenMembership?.role !== null) {
            // Explicit-role keys need OWNER/ADMIN; inherited keys (role null) fall
            // through to the owner's own authority below.
            return tokenMembership?.role === 'OWNER' || tokenMembership?.role === 'ADMIN';
          }

          if (targetDrive?.ownerId === userId) return true;

          // Authz read: a pending invitee (acceptedAt IS NULL) with role ADMIN
          // would otherwise pass the role check and be allowed to write into a
          // drive they have not accepted into. Closes Review C2.
          const membership = await db.query.driveMembers.findFirst({
            where: and(
              eq(driveMembers.driveId, driveId),
              eq(driveMembers.userId, userId),
              isNotNull(driveMembers.acceptedAt)
            ),
          });
          return membership?.role === 'OWNER' || membership?.role === 'ADMIN';
        },

        canEditPage: (pageId) => canPrincipalEditPage(auth, pageId),
      },
      activity: {
        changeGroupType: 'user',
        metadata: {
          bulkOperation: 'move',
          totalPages: pageIds.length,
          ...(isMCPAuthResult(auth) && { source: 'mcp' }),
        },
      },
    });

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    // Broadcast events
    for (const driveId of result.affectedDriveIds) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, '', 'moved')
      );
    }

    // Sync the subdomain root for drives whose home page was bulk-moved away.
    // Fire-and-forget: never blocks the response; syncPublishedHomeRoot swallows errors.
    for (const driveId of result.clearedHomePageDriveIds) {
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
