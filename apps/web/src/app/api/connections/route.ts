import { NextResponse } from 'next/server';
import { db, connections, users, userProfiles, eq, and, or, desc } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createNotification, isEmailVerified } from '@pagespace/lib';

// GET /api/connections - Get user's connections
export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'ACCEPTED';

    // Get all connections where user is either user1 or user2
    const userConnections = await db
      .select({
        id: connections.id,
        status: connections.status,
        requestedAt: connections.requestedAt,
        acceptedAt: connections.acceptedAt,
        requestMessage: connections.requestMessage,
        user1Id: connections.user1Id,
        user2Id: connections.user2Id,
        requestedBy: connections.requestedBy,
      })
      .from(connections)
      .where(
        and(
          or(
            eq(connections.user1Id, user.id),
            eq(connections.user2Id, user.id)
          ),
          eq(connections.status, status as 'PENDING' | 'ACCEPTED' | 'BLOCKED')
        )
      )
      .orderBy(desc(connections.acceptedAt), desc(connections.requestedAt));

    // Get user details for each connection
    const connectionDetails = await Promise.all(
      userConnections.map(async (conn) => {
        // Ensure we have valid user IDs
        if (!conn.user1Id || !conn.user2Id) {
          console.error('Invalid connection data:', conn);
          return null;
        }

        const otherUserId = conn.user1Id === user.id ? conn.user2Id : conn.user1Id;

        const [otherUser] = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            image: users.image,
            username: userProfiles.username,
            displayName: userProfiles.displayName,
            bio: userProfiles.bio,
            avatarUrl: userProfiles.avatarUrl,
          })
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, otherUserId))
          .limit(1);

        // Skip if we couldn't find the other user
        if (!otherUser) {
          console.error('User not found:', otherUserId);
          return null;
        }

        return {
          ...conn,
          user: otherUser,
          isRequester: conn.requestedBy === user.id,
        };
      })
    );

    // Filter out any null results
    const validConnections = connectionDetails.filter(conn => conn !== null);

    return NextResponse.json({ connections: validConnections });
  } catch (error) {
    loggers.api.error('Error fetching connections:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch connections' },
      { status: 500 }
    );
  }
}

// POST /api/connections - Send a connection request
export async function POST(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check email verification
    const emailVerified = await isEmailVerified(user.id);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { targetUserId, message } = body;

    if (!targetUserId) {
      return NextResponse.json(
        { error: 'Target user ID is required' },
        { status: 400 }
      );
    }

    if (targetUserId === user.id) {
      return NextResponse.json(
        { error: 'Cannot connect with yourself' },
        { status: 400 }
      );
    }

    // Check if connection already exists
    const existingConnection = await db
      .select()
      .from(connections)
      .where(
        or(
          and(
            eq(connections.user1Id, user.id),
            eq(connections.user2Id, targetUserId)
          ),
          and(
            eq(connections.user1Id, targetUserId),
            eq(connections.user2Id, user.id)
          )
        )
      )
      .limit(1);

    if (existingConnection.length > 0) {
      const conn = existingConnection[0];
      if (conn.status === 'ACCEPTED') {
        return NextResponse.json(
          { error: 'Already connected with this user' },
          { status: 400 }
        );
      } else if (conn.status === 'PENDING') {
        return NextResponse.json(
          { error: 'Connection request already pending' },
          { status: 400 }
        );
      } else if (conn.status === 'BLOCKED') {
        return NextResponse.json(
          { error: 'Cannot send connection request' },
          { status: 400 }
        );
      }
    }

    // Ensure user1Id < user2Id for consistency
    const [user1Id, user2Id] = [user.id, targetUserId].sort();

    // Create new connection request
    const [newConnection] = await db
      .insert(connections)
      .values({
        user1Id,
        user2Id,
        status: 'PENDING',
        requestedBy: user.id,
        requestMessage: message,
      })
      .returning();

    // Get sender's name for the notification
    const [sender] = await db
      .select({
        name: users.name,
        displayName: userProfiles.displayName,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(users.id, user.id))
      .limit(1);

    const senderName = sender?.displayName || sender?.name || 'Someone';

    // Send notification to target user (broadcasts via Socket.IO)
    await createNotification({
      userId: targetUserId,
      type: 'CONNECTION_REQUEST',
      title: 'New Connection Request',
      message: `${senderName} wants to connect with you`,
      metadata: {
        connectionId: newConnection.id,
        senderId: user.id,
        requestMessage: message,
        requesterName: senderName, // For email template
      },
      triggeredByUserId: user.id,
    });

    return NextResponse.json({ connection: newConnection });
  } catch (error) {
    loggers.api.error('Error creating connection request:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create connection request' },
      { status: 500 }
    );
  }
}
