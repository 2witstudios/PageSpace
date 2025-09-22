import { NextRequest, NextResponse } from 'next/server';
import { db, drives, eq } from '@pagespace/db';
import { z } from 'zod/v4';
import { slugify } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';

// Schema for drive creation
const createDriveSchema = z.object({
  name: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
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

    return NextResponse.json(newDrive, { status: 201 });
  } catch (error) {
    loggers.api.error('Error in MCP drive creation:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}

// GET endpoint to list drives (for completeness)
export async function GET(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const userId = auth.userId;
    // Get user's drives
    const userDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
    });

    return NextResponse.json(userDrives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch drives' },
      { status: 500 }
    );
  }
}