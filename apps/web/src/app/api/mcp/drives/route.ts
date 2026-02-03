import { NextRequest, NextResponse } from 'next/server';
import { db, drives } from '@pagespace/db';
import { z } from 'zod/v4';
import { slugify } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/server';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult } from '@/lib/auth';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';

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
    if (name.toLowerCase() === 'personal') {
      return NextResponse.json({ error: 'Cannot create a drive named "Personal"' }, { status: 400 });
    }

    const slug = slugify(name);

    // Create the new drive
    const [newDrive] = await db.insert(drives).values({
      name,
      slug,
      ownerId: userId,
      updatedAt: new Date(),
    }).returning();

    // Broadcast drive creation event
    await broadcastDriveEvent(
      createDriveEventPayload(newDrive.id, 'created', {
        name: newDrive.name,
        slug: newDrive.slug,
      })
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
      // Token is scoped to specific drives - only return those the user can access
      const scopeSet = new Set(allowedDriveIds);
      filteredDrives = allAccessibleDrives.filter(drive => scopeSet.has(drive.id));
    } else {
      // Token has no scope restrictions - return all accessible drives
      filteredDrives = allAccessibleDrives;
    }

    return NextResponse.json(filteredDrives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch drives' },
      { status: 500 }
    );
  }
}