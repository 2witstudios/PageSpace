import { NextResponse } from 'next/server';
import { db, eq } from '@pagespace/db';
import { userProfiles, users } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';

export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile
    const profile = await db.select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1);

    if (profile.length === 0) {
      // Return basic user info if no profile exists
      const userInfo = await db.select({
        id: users.id,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

      return NextResponse.json({
        userId: user.id,
        email: userInfo[0]?.email,
        displayName: userInfo[0]?.name || 'Unknown User',
        username: null,
        bio: null,
        avatarUrl: null,
        isPublic: false,
      });
    }

    return NextResponse.json(profile[0]);
  } catch (error) {
    loggers.api.error('Error fetching user profile:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch profile' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { username, displayName, bio, avatarUrl, isPublic } = body;

    // Validate username uniqueness if provided
    if (username) {
      const existing = await db.select()
        .from(userProfiles)
        .where(eq(userProfiles.username, username))
        .limit(1);

      if (existing.length > 0 && existing[0].userId !== user.id) {
        return NextResponse.json(
          { error: 'Username already taken' },
          { status: 400 }
        );
      }
    }

    // Check if profile exists
    const existingProfile = await db.select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1);

    if (existingProfile.length > 0) {
      // Update existing profile
      const updated = await db.update(userProfiles)
        .set({
          username: username || existingProfile[0].username,
          displayName: displayName || existingProfile[0].displayName,
          bio: bio !== undefined ? bio : existingProfile[0].bio,
          avatarUrl: avatarUrl !== undefined ? avatarUrl : existingProfile[0].avatarUrl,
          isPublic: isPublic !== undefined ? isPublic : existingProfile[0].isPublic,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, user.id))
        .returning();

      return NextResponse.json(updated[0]);
    } else {
      // Create new profile
      const created = await db.insert(userProfiles)
        .values({
          userId: user.id,
          username: username || `user_${user.id.slice(0, 8)}`,
          displayName: displayName || 'Unknown User',
          bio: bio || null,
          avatarUrl: avatarUrl || null,
          isPublic: isPublic || false,
          updatedAt: new Date(),
        })
        .returning();

      return NextResponse.json(created[0]);
    }
  } catch (error) {
    loggers.api.error('Error updating user profile:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update profile' },
      { status: 500 }
    );
  }
}