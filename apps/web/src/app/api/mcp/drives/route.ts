import { NextRequest, NextResponse } from 'next/server';
import { db, drives, mcpTokens, eq, isNull, and } from '@pagespace/db';
import { z } from 'zod/v4';
import { slugify } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

// Validate MCP token and return user ID
async function validateMCPToken(token: string): Promise<string | null> {
  try {
    if (!token || !token.startsWith('mcp_')) {
      return null;
    }

    // Find the token in database (checking for non-revoked tokens)
    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
    });

    if (!tokenData) {
      return null;
    }

    // Update last used timestamp
    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, tokenData.id));

    return tokenData.userId;
  } catch (error) {
    loggers.api.error('MCP token validation error:', error as Error);
    return null;
  }
}

// Get user ID from MCP token
async function getUserId(req: NextRequest): Promise<string | null> {
  // Check for Bearer token (MCP authentication)
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer mcp_')) {
    const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
    const userId = await validateMCPToken(mcpToken);
    return userId; // Returns userId on success, null on failure
  }

  return null; // No valid auth header found
}

// Schema for drive creation
const createDriveSchema = z.object({
  name: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
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
  const userId = await getUserId(req);
  
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
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