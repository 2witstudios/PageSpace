import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { drives } from '@pagespace/db/schema/core';
import { z } from 'zod/v4';
import { slugify } from '@pagespace/lib/utils/utils';
import { isReservedDriveName } from '@pagespace/lib/services/drive-guards';
import { allocatePublishSubdomain } from '@pagespace/lib/services/drive-service';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { eq } from '@pagespace/db/operators';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { authenticateMCPRequest } from '@/lib/auth/request-auth';
import { isAuthError, isMCPAuthResult } from '@/lib/auth/auth-core';

// Schema for drive creation
const createDriveSchema = z.object({
  name: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check if this MCP token has drive scope restrictions
  // Scoped tokens cannot create new drives (they only have access to specific drives)
  if (isMCPAuthResult(auth) && (auth.allowedDriveIds?.length ?? 0) > 0) {
    return NextResponse.json(
      { error: 'This token is scoped to specific drives and cannot create new drives' },
      { status: 403 }
    );
  }

  try {
    const userId = auth.userId;
    const body = await req.json();
    const { name } = createDriveSchema.parse(body);
    
    // Validate name
    if (isReservedDriveName(name)) {
      return NextResponse.json({ error: 'Cannot create a drive with that name.' }, { status: 400 });
    }

    const slug = slugify(name);

    // Create drive + allocate subdomain atomically — allocation failure after insert
    // would leave a drive without a subdomain identity.
    const newDrive = await db.transaction(async (tx) => {
      const [created] = await tx.insert(drives).values({
        name,
        slug,
        ownerId: userId,
        updatedAt: new Date(),
      }).returning();
      await allocatePublishSubdomain(created.id, slug, tx);
      return created;
    });

    // Broadcast drive creation event (only creator receives for new drives)
    await broadcastDriveEvent(
      createDriveEventPayload(newDrive.id, 'created', {
        name: newDrive.name,
        slug: newDrive.slug,
      }),
      [userId]
    );

    // Log MCP drive creation for compliance (fire-and-forget)
    const actorInfo = await getActorInfo(userId);
    logDriveActivity(userId, 'create', {
      id: newDrive.id,
      name: newDrive.name,
    }, {
      ...actorInfo,
      metadata: { source: 'mcp' },
    });

    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'drive', resourceId: newDrive.id, details: { source: 'mcp' } });

    return NextResponse.json(newDrive, { status: 201 });
  } catch (error) {
    loggers.api.error('Error in MCP drive creation:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}

// GET endpoint to list drives
// Zero Trust: Returns all drives user has access to (owned + shared), filtered by token scope
export async function GET(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const userId = auth.userId;

    // Check if this MCP token has drive scope restrictions
    let allowedDriveIds: string[] = [];
    if (isMCPAuthResult(auth)) {
      allowedDriveIds = auth.allowedDriveIds ?? [];
    }

    // Get all drives user has access to (owned + shared via membership)
    const allAccessibleDrives = await listAccessibleDrives(userId);

    // Filter by token scope if applicable
    let filteredDrives;
    if (allowedDriveIds.length > 0) {
      // Scoped token: its drive universe is its mcp_token_drives memberships.
      // Drives the user can also access keep the user-derived shape; drives the
      // token holds an EXPLICIT role in (added by a drive admin) are listed
      // even when the owning user is not a member — parity with /api/drives.
      const accessibleById = new Map(allAccessibleDrives.map((d) => [d.id, d]));
      const tokenId = isMCPAuthResult(auth) ? auth.tokenId : null;
      filteredDrives = (
        await Promise.all(
          allowedDriveIds.map(async (driveId) => {
            const userView = accessibleById.get(driveId);
            if (userView) return userView;
            if (!tokenId) return null;
            const membership = await getAppDriveMembership(tokenId, driveId);
            if (!membership || membership.role === null) return null; // dangling inherit
            const drive = await db.query.drives.findFirst({ where: eq(drives.id, driveId) });
            if (!drive || drive.isTrashed) return null;
            return { ...drive, isOwned: false, role: membership.role, lastAccessedAt: null };
          }),
        )
      ).filter((d): d is NonNullable<typeof d> => d !== null);
    } else {
      // Token has no scope restrictions - return all accessible drives
      filteredDrives = allAccessibleDrives;
    }

    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'drive', resourceId: '*', details: { source: 'mcp', driveCount: filteredDrives.length } });

    return NextResponse.json(filteredDrives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch drives' },
      { status: 500 }
    );
  }
}