import { NextResponse } from 'next/server';
import { db, eq, and, or, ilike, userProfiles, users } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50);

    if (!query || query.length < 2) {
      return NextResponse.json({ users: [] });
    }

    // Search for users by username, display name, or email
    // Only search public profiles or exact email matches
    const searchPattern = `%${query}%`;

    // First, search in user profiles (public only)
    const profileResults = await db.select({
      userId: userProfiles.userId,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      bio: userProfiles.bio,
      avatarUrl: userProfiles.avatarUrl,
      email: users.email,
    })
    .from(userProfiles)
    .leftJoin(users, eq(userProfiles.userId, users.id))
    .where(
      and(
        eq(userProfiles.isPublic, true),
        or(
          ilike(userProfiles.username, searchPattern),
          ilike(userProfiles.displayName, searchPattern)
        )
      )
    )
    .limit(limit);

    // Also search by email (exact match for privacy)
    const emailResults = await db.select({
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .where(eq(users.email, query))
    .limit(1);

    // Combine results, avoiding duplicates
    const userMap = new Map();
    
    // Add profile results
    for (const result of profileResults) {
      userMap.set(result.userId, {
        userId: result.userId,
        username: result.username,
        displayName: result.displayName,
        bio: result.bio,
        avatarUrl: result.avatarUrl,
        email: result.email,
      });
    }

    // Add email results if not already in map
    for (const result of emailResults) {
      if (!userMap.has(result.userId)) {
        // Check if this user has a profile
        const profile = await db.select()
          .from(userProfiles)
          .where(eq(userProfiles.userId, result.userId))
          .limit(1);

        if (profile.length > 0) {
          userMap.set(result.userId, {
            userId: result.userId,
            username: profile[0].username,
            displayName: profile[0].displayName,
            bio: profile[0].bio,
            avatarUrl: profile[0].avatarUrl,
            email: result.email,
          });
        } else {
          // User without profile
          userMap.set(result.userId, {
            userId: result.userId,
            username: null,
            displayName: result.name || 'Unknown User',
            bio: null,
            avatarUrl: null,
            email: result.email,
          });
        }
      }
    }

    const userResults = Array.from(userMap.values());

    return NextResponse.json({ users: userResults });
  } catch (error) {
    loggers.api.error('Error searching users:', error as Error);
    return NextResponse.json(
      { error: 'Failed to search users' },
      { status: 500 }
    );
  }
}