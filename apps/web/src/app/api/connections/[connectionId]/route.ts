import { NextResponse } from 'next/server';
import { db, connections, users, userProfiles, eq } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createNotification } from '@pagespace/lib';

// PATCH /api/connections/[connectionId] - Accept, reject, or block a connection
export async function PATCH(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { connectionId } = await context.params;
    const body = await request.json();
    const { action } = body;

    if (!['accept', 'reject', 'block', 'unblock'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action' },
        { status: 400 }
      );
    }

    // Get the connection
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!connection) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Check if user is part of this connection
    if (connection.user1Id !== user.id && connection.user2Id !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized to modify this connection' },
        { status: 403 }
      );
    }

    let updateData: Record<string, unknown> = {};
    let notificationType: string | null = null;
    let notifyUserId: string | null = null;

    switch (action) {
      case 'accept':
        // Only the recipient can accept
        if (connection.requestedBy === user.id) {
          return NextResponse.json(
            { error: 'Cannot accept your own request' },
            { status: 400 }
          );
        }
        if (connection.status !== 'PENDING') {
          return NextResponse.json(
            { error: 'Connection is not pending' },
            { status: 400 }
          );
        }
        updateData = {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        };
        notificationType = 'CONNECTION_ACCEPTED';
        notifyUserId = connection.requestedBy;
        break;

      case 'reject':
        // Only the recipient can reject
        if (connection.requestedBy === user.id) {
          return NextResponse.json(
            { error: 'Cannot reject your own request' },
            { status: 400 }
          );
        }
        if (connection.status !== 'PENDING') {
          return NextResponse.json(
            { error: 'Connection is not pending' },
            { status: 400 }
          );
        }
        // Delete the connection request instead of updating status
        await db.delete(connections).where(eq(connections.id, connectionId));

        // Get the name of the person rejecting
        const [rejectUser] = await db
          .select({
            name: users.name,
            displayName: userProfiles.displayName,
          })
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, user.id))
          .limit(1);

        const rejectUserName = rejectUser?.displayName || rejectUser?.name || 'Someone';

        // Send rejection notification (broadcast via Socket.IO)
        await createNotification({
          userId: connection.requestedBy,
          type: 'CONNECTION_REJECTED',
          title: 'Connection Request Declined',
          message: `${rejectUserName} declined your connection request`,
          metadata: {
            rejecterName: rejectUserName,
          },
          triggeredByUserId: user.id,
        });

        return NextResponse.json({ success: true });

      case 'block':
        updateData = {
          status: 'BLOCKED',
          blockedBy: user.id,
          blockedAt: new Date(),
        };
        break;

      case 'unblock':
        if (connection.status !== 'BLOCKED') {
          return NextResponse.json(
            { error: 'Connection is not blocked' },
            { status: 400 }
          );
        }
        if (connection.blockedBy !== user.id) {
          return NextResponse.json(
            { error: 'Only the blocker can unblock' },
            { status: 400 }
          );
        }
        // Reset to pending or delete based on your preference
        await db.delete(connections).where(eq(connections.id, connectionId));
        return NextResponse.json({ success: true });
    }

    // Update the connection
    const [updatedConnection] = await db
      .update(connections)
      .set(updateData)
      .where(eq(connections.id, connectionId))
      .returning();

    // Send notification if needed
    if (notificationType && notifyUserId) {
      // Get the name of the person performing the action
      const [actionUser] = await db
        .select({
          name: users.name,
          displayName: userProfiles.displayName,
        })
        .from(users)
        .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
        .where(eq(users.id, user.id))
        .limit(1);

      const actionUserName = actionUser?.displayName || actionUser?.name || 'Someone';

      await createNotification({
        userId: notifyUserId!,
        type: notificationType as 'CONNECTION_ACCEPTED' | 'CONNECTION_REJECTED',
        title: notificationType === 'CONNECTION_ACCEPTED'
          ? 'Connection Request Accepted'
          : 'Connection Update',
        message: notificationType === 'CONNECTION_ACCEPTED'
          ? `${actionUserName} accepted your connection request`
          : 'Your connection status has been updated',
        metadata: {
          accepterName: notificationType === 'CONNECTION_ACCEPTED' ? actionUserName : undefined,
          rejecterName: notificationType === 'CONNECTION_REJECTED' ? actionUserName : undefined,
        },
        triggeredByUserId: user.id,
      });
    }

    return NextResponse.json({ connection: updatedConnection });
  } catch (error) {
    loggers.api.error('Error updating connection:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update connection' },
      { status: 500 }
    );
  }
}

// DELETE /api/connections/[connectionId] - Remove a connection
export async function DELETE(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { connectionId } = await context.params;

    // Get the connection
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!connection) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Check if user is part of this connection
    if (connection.user1Id !== user.id && connection.user2Id !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized to delete this connection' },
        { status: 403 }
      );
    }

    // Delete the connection
    await db.delete(connections).where(eq(connections.id, connectionId));

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting connection:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete connection' },
      { status: 500 }
    );
  }
}
