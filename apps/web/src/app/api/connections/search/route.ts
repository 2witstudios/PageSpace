import { NextResponse } from 'next/server';
import { db, users, userProfiles, connections, eq, and, or } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';

// GET /api/connections/search - Search for users by email to connect with
export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');

    if (!email) {
      return NextResponse.json({ user: null });
    }

    // Get current user's email to check for self-connection
    const [currentUser] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    // Check if user is trying to search for themselves
    if (email === currentUser?.email) {
      return NextResponse.json({
        user: null,
        error: 'Cannot connect with yourself'
      });
    }

    // Find user by exact email match
    const [targetUser] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        displayName: userProfiles.displayName,
        bio: userProfiles.bio,
        avatarUrl: userProfiles.avatarUrl,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(users.email, email))
      .limit(1);

    if (!targetUser) {
      return NextResponse.json({
        user: null,
        error: 'No user found with this email address'
      });
    }

    // Check if connection already exists - using basic select that always works
    const existingConnections = await db
      .select()  // Select ALL fields to avoid production issues
      .from(connections)
      .where(
        or(
          and(
            eq(connections.user1Id, user.id),
            eq(connections.user2Id, targetUser.id)
          ),
          and(
            eq(connections.user1Id, targetUser.id),
            eq(connections.user2Id, user.id)
          )
        )
      )
      .limit(1);

    // Check if connection exists and handle different statuses
    if (existingConnections.length > 0) {
      const existingConnection = existingConnections[0];

      // Defensive check to ensure status exists
      if (!existingConnection || !existingConnection.status) {
        loggers.api.error('Invalid connection data structure');
        return NextResponse.json({
          user: null,
          error: 'Connection check failed'
        });
      }

      if (existingConnection.status === 'ACCEPTED') {
        return NextResponse.json({
          user: null,
          error: 'Already connected with this user'
        });
      } else if (existingConnection.status === 'PENDING') {
        return NextResponse.json({
          user: null,
          error: 'Connection request already pending'
        });
      } else if (existingConnection.status === 'BLOCKED') {
        return NextResponse.json({
          user: null,
          error: 'Cannot send connection request to this user'
        });
      }
    }

    // Return the user data for connection
    return NextResponse.json({
      user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        displayName: targetUser.displayName || targetUser.name,
        bio: targetUser.bio,
        avatarUrl: targetUser.avatarUrl,
      }
    });
  } catch (error) {
    loggers.api.error('Error searching for user:', error as Error);
    return NextResponse.json(
      { error: 'Failed to search user' },
      { status: 500 }
    );
  }
}