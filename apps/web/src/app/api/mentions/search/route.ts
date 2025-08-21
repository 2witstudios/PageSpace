import { NextResponse } from 'next/server';
import { decodeToken, getUserAccessLevel } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, users, db, and, eq, ilike, drives, inArray } from '@pagespace/db';
import { MentionSuggestion, MentionType } from '@/types/mentions';
import { loggers } from '@pagespace/lib/logger-config';

// Helper function to get all drives a user has access to
async function getUserAccessibleDrives(userId: string): Promise<Array<{id: string, name: string, slug: string}>> {
  try {
    // Get drives where user is owner
    const ownedDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: {
        id: true,
        name: true,
        slug: true
      }
    });

    loggers.api.debug('[getUserAccessibleDrives] User has access to drives', { userId, driveCount: ownedDrives.length });
    return ownedDrives;
  } catch (error) {
    loggers.api.error('Error getting user accessible drives:', error as Error);
    return [];
  }
}

export async function GET(request: Request) {
  loggers.api.debug('[API] /api/mentions/search - Request received', {});
  
  const cookieHeader = request.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    loggers.api.debug('[API] No access token found', {});
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded) {
    loggers.api.debug('[API] Failed to decode token', {});
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const userId = decoded.userId;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  const driveId = searchParams.get('driveId');
  const crossDrive = searchParams.get('crossDrive') === 'true'; // Flag for cross-drive search
  const typesParam = searchParams.get('types'); // Comma-separated types
  
  loggers.api.debug('[API] Search params', { query, driveId, crossDrive, types: typesParam });
  
  // For within-drive searches, driveId is required
  // For cross-drive searches, driveId is optional (searches all accessible drives)
  if (!crossDrive && !driveId) {
    loggers.api.debug('[API] Missing driveId parameter for within-drive search', {});
    return NextResponse.json(
      { error: 'Missing driveId parameter for within-drive search' },
      { status: 400 }
    );
  }

  // Parse requested mention types, default to all types
  const requestedTypes = typesParam 
    ? typesParam.split(',') as MentionType[]
    : ['page', 'user'];

  try {
    const suggestions: MentionSuggestion[] = [];

    // Get target drive IDs based on search mode
    let targetDriveIds: string[];
    const driveContextMap: Map<string, string> = new Map(); // driveId -> drive name/slug for context
    
    if (crossDrive) {
      // Cross-drive search: get all accessible drives
      const accessibleDrives = await getUserAccessibleDrives(userId);
      targetDriveIds = accessibleDrives.map(d => d.id);
      
      // Build context map for drive disambiguation
      accessibleDrives.forEach(drive => {
        driveContextMap.set(drive.id, drive.name || drive.slug);
      });
      
      loggers.api.debug('[API] Cross-drive search', { driveCount: targetDriveIds.length });
    } else {
      // Within-drive search: only search the specified drive
      targetDriveIds = [driveId!];
      loggers.api.debug('[API] Within-drive search', { driveId });
    }

    if (targetDriveIds.length === 0) {
      loggers.api.debug('[API] No accessible drives found for user', {});
      return NextResponse.json([]);
    }

    // Search pages (all page types)
    if (requestedTypes.includes('page')) {
      const pageResults = await db.select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        driveId: pages.driveId,
      })
      .from(pages)
      .where(
        and(
          inArray(pages.driveId, targetDriveIds), // Search across target drives
          query ? ilike(pages.title, `%${query}%`) : undefined,
          eq(pages.isTrashed, false)
        )
      )
      .limit(20); // Increased limit for cross-drive searches

      // Filter by permissions and requested types
      for (const page of pageResults) {
        const accessLevel = await getUserAccessLevel(userId, page.id);
        if (!accessLevel) continue;

        // All page types are now under 'page' mention type
        if (!requestedTypes.includes('page')) {
          continue; // Skip if page type not requested
        }
        
        const mentionType: MentionType = 'page';

        // Include drive context for cross-drive searches
        const driveContext = crossDrive ? driveContextMap.get(page.driveId) : undefined;
        const description = crossDrive && driveContext 
          ? `${page.type.toLowerCase()} in ${driveContext}`
          : `${page.type.toLowerCase()} in drive`;

        suggestions.push({
          id: page.id,
          label: page.title,
          type: mentionType,
          data: {
            pageType: page.type as 'DOCUMENT' | 'FOLDER' | 'CHANNEL' | 'AI_CHAT',
            driveId: page.driveId,
          },
          description,
        });
      }
    }

    // Search users (if user mentions are requested)
    if (requestedTypes.includes('user')) {
      const authorizedUserIds = new Set<string>();
      
      if (crossDrive) {
        // Cross-drive search: collect users from all accessible drives
        for (const targetDriveId of targetDriveIds) {
          // Get the drive owner
          const driveResults = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, targetDriveId)).limit(1);
          const drive = driveResults[0];
          
          if (drive) {
            authorizedUserIds.add(drive.ownerId);
          }
        }
      } else {
        // Within-drive search: only users from the specified drive
        const driveResults = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId!)).limit(1);
        const drive = driveResults[0];
        
        if (!drive) {
          return new NextResponse('Drive not found', { status: 404 });
        }

        // Add the drive owner
        authorizedUserIds.add(drive.ownerId);
      }

      // Search for users only within the authorized set
      if (authorizedUserIds.size > 0) {
        const userResults = await db.select({
          id: users.id,
          name: users.name,
          image: users.image,
        })
        .from(users)
        .where(
          and(
            inArray(users.id, Array.from(authorizedUserIds)),
            query ? ilike(users.name, `%${query}%`) : undefined
          )
        )
        .limit(10); // Increased limit for cross-drive searches

        // Create suggestions without exposing email addresses or avatars
        for (const user of userResults) {
          suggestions.push({
            id: user.id,
            label: user.name || 'Unnamed User',
            type: 'user',
            data: {},
            description: crossDrive ? 'User (cross-drive)' : 'User',
          });
        }
      }
    }


    // Sort suggestions by relevance (exact matches first, then alphabetical)
    suggestions.sort((a, b) => {
      const aExact = a.label.toLowerCase() === query.toLowerCase();
      const bExact = b.label.toLowerCase() === query.toLowerCase();
      
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      
      return a.label.localeCompare(b.label);
    });

    const finalSuggestions = suggestions.slice(0, 10);
    loggers.api.debug('[API] Returning suggestions', { count: finalSuggestions.length, suggestions: finalSuggestions });
    return NextResponse.json(finalSuggestions);
  } catch (error) {
    loggers.api.error('[MENTIONS_SEARCH_GET]', error as Error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}