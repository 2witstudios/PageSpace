import { NextResponse } from 'next/server';
import { decodeToken, slugify } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, pages, driveMembers, pagePermissions, db, and, eq, inArray, not, mcpTokens, isNull } from '@pagespace/db';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';

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

    loggers.api.debug('[DEBUG] MCP Token validation successful - User ID:', { userId: tokenData.userId });
    return tokenData.userId;
  } catch (error) {
    loggers.api.error('MCP token validation error:', error as Error);
    return null;
  }
}

// Get user ID from either cookie or MCP token
async function getUserId(req: Request): Promise<string | null> {
  // Check for Bearer token (MCP authentication) first
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer mcp_')) {
    const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
    const userId = await validateMCPToken(mcpToken);
    if (userId) {
      return userId;
    }
  }

  // Fall back to cookie authentication
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return null;
  }

  const decoded = await decodeToken(accessToken);
  return decoded ? decoded.userId : null;
}

export async function GET(req: Request) {
  const userId = await getUserId(req);

  loggers.api.debug('[DEBUG] Drives API - User ID:', { userId });

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    // 1. Get user's own drives
    const ownedDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
    });

    // 2. Get drives where user is a member (new RBAC system)
    const memberDrives = await db.selectDistinct({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId));

    // 3. Get drives where user has page permissions (new RBAC system)
    const permissionDrives = await db.selectDistinct({ driveId: pages.driveId })
      .from(pagePermissions)
      .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(
        eq(pagePermissions.userId, userId),
        eq(pagePermissions.canView, true)
      ));

    // 4. Combine all shared drive IDs (from members and page permissions)
    const allSharedDriveIds = new Set<string>();
    memberDrives.forEach(d => d.driveId && allSharedDriveIds.add(d.driveId));
    permissionDrives.forEach(d => d.driveId && allSharedDriveIds.add(d.driveId));
    
    const sharedDriveIds = Array.from(allSharedDriveIds);

    // 5. Fetch the actual drive objects, excluding ones the user already owns
    const sharedDrives = sharedDriveIds.length > 0 ? await db.query.drives.findMany({
      where: and(
        inArray(drives.id, sharedDriveIds),
        not(eq(drives.ownerId, userId))
      ),
    }) : [];

    // 6. Combine and add the isOwned flag
    const allDrives = [
      ...ownedDrives.map((drive) => ({ ...drive, isOwned: true })),
      ...sharedDrives.map((drive) => ({ ...drive, isOwned: false })),
    ];

    // Deduplicate in case a drive is both owned and shared (shouldn't happen with current logic, but good practice)
    const uniqueDrives = Array.from(new Map(allDrives.map(d => [d.id, d])).values());

    loggers.api.debug('[DEBUG] Drives API - Found drives:', { 
      count: uniqueDrives.length, 
      drives: uniqueDrives.map(d => ({ id: d.id, name: d.name, slug: d.slug })) 
    });

    return NextResponse.json(uniqueDrives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch drives' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const userId = await getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const session = { user: { id: userId } };

  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }
    
    if (name.toLowerCase() === 'personal') {
        return NextResponse.json({ error: 'Cannot create a drive named "Personal".' }, { status: 400 });
    }

    const slug = slugify(name);

    const newDrive = await db.insert(drives).values({
      name,
      slug,
      ownerId: session.user.id,
      updatedAt: new Date(),
    }).returning();

    // Broadcast drive creation event
    await broadcastDriveEvent(
      createDriveEventPayload(newDrive[0].id, 'created', {
        name: newDrive[0].name,
        slug: newDrive[0].slug,
      })
    );

    // Track drive creation
    trackDriveOperation(userId, 'create', newDrive[0].id, {
      name: newDrive[0].name,
      slug: newDrive[0].slug
    });

    return NextResponse.json(newDrive[0], { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}