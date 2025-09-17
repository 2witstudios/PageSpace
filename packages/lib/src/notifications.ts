import { db, notifications, users, pages, drives, eq, and, desc, count, sql } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Export types and guards
export * from './notifications/types';
export * from './notifications/guards';

async function broadcastNotification(userId: string, notification: unknown) {
  try {
    const realtimeUrl = process.env.INTERNAL_REALTIME_URL || 'http://localhost:3001';
    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: `notifications:${userId}`,
        event: 'notification:new',
        payload: notification,
      }),
    });
  } catch (error) {
    console.error('Failed to broadcast notification:', error);
  }
}

export type NotificationType = 
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED' 
  | 'PERMISSION_UPDATED'
  | 'PAGE_SHARED'
  | 'DRIVE_INVITED'
  | 'DRIVE_JOINED'
  | 'DRIVE_ROLE_CHANGED'
  | 'CONNECTION_REQUEST'
  | 'CONNECTION_ACCEPTED'
  | 'CONNECTION_REJECTED'
  | 'NEW_DIRECT_MESSAGE';

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  pageId?: string;
  driveId?: string;
  triggeredByUserId?: string;
}

export async function createNotification(params: CreateNotificationParams) {
  const notification = await db.insert(notifications).values({
    id: createId(),
    ...params,
  }).returning();
  
  // Broadcast notification to user via Socket.IO
  await broadcastNotification(params.userId, notification[0]);
  
  return notification[0];
}

export async function getUserNotifications(userId: string, limit = 50) {
  const userNotifications = await db
    .select({
      notification: notifications,
      triggeredByUser: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      },
      drive: {
        id: drives.id,
        slug: drives.slug,
        name: drives.name,
      },
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.triggeredByUserId, users.id))
    .leftJoin(drives, eq(notifications.driveId, drives.id))
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return userNotifications.map(row => ({
    ...row.notification,
    triggeredByUser: row.triggeredByUser,
    drive: row.drive,
  }));
}

export async function getUnreadNotificationCount(userId: string) {
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      )
    );
  
  return Number(result[0]?.count || 0);
}

export async function markNotificationAsRead(notificationId: string, userId: string) {
  const updated = await db
    .update(notifications)
    .set({ 
      isRead: true,
      readAt: new Date(),
    })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      )
    )
    .returning();

  return updated[0];
}

export async function markAllNotificationsAsRead(userId: string) {
  await db
    .update(notifications)
    .set({ 
      isRead: true,
      readAt: new Date(),
    })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      )
    );
}

export async function deleteNotification(notificationId: string, userId: string) {
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      )
    );
}

export async function createPermissionNotification(
  targetUserId: string,
  pageId: string,
  type: 'granted' | 'updated' | 'revoked',
  permissions: { canView?: boolean; canEdit?: boolean; canShare?: boolean; canDelete?: boolean },
  triggeredByUserId: string
) {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    with: {
      drive: true,
    },
  });

  if (!page) return null;

  const triggeredByUser = await db.query.users.findFirst({
    where: eq(users.id, triggeredByUserId),
  });

  const permissionList = [];
  if (permissions.canView) permissionList.push('view');
  if (permissions.canEdit) permissionList.push('edit');
  if (permissions.canShare) permissionList.push('share');
  if (permissions.canDelete) permissionList.push('delete');

  let notificationType: NotificationType;
  let title: string;
  let message: string;

  switch (type) {
    case 'granted':
      notificationType = 'PAGE_SHARED';
      title = `Page shared with you`;
      message = `${triggeredByUser?.name || 'Someone'} shared "${page.title}" with you (${permissionList.join(', ')} access)`;
      break;
    case 'updated':
      notificationType = 'PERMISSION_UPDATED';
      title = `Permissions updated`;
      message = `Your permissions for "${page.title}" have been updated (${permissionList.join(', ')} access)`;
      break;
    case 'revoked':
      notificationType = 'PERMISSION_REVOKED';
      title = `Access removed`;
      message = `Your access to "${page.title}" has been removed`;
      break;
  }

  return createNotification({
    userId: targetUserId,
    type: notificationType,
    title,
    message,
    metadata: {
      permissions,
      pageName: page.title,
      driveName: page.drive?.name,
    },
    pageId,
    driveId: page.driveId,
    triggeredByUserId,
  });
}

export async function createDriveNotification(
  targetUserId: string,
  driveId: string,
  type: 'invited' | 'joined' | 'role_changed',
  role?: string,
  triggeredByUserId?: string
) {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
  });

  if (!drive) return null;

  const triggeredByUser = triggeredByUserId ? await db.query.users.findFirst({
    where: eq(users.id, triggeredByUserId),
  }) : null;

  let notificationType: NotificationType;
  let title: string;
  let message: string;

  switch (type) {
    case 'invited':
      notificationType = 'DRIVE_INVITED';
      title = `Drive invitation`;
      message = `${triggeredByUser?.name || 'Someone'} invited you to join the "${drive.name}" drive`;
      break;
    case 'joined':
      notificationType = 'DRIVE_JOINED';
      title = `Joined drive`;
      message = `You've been added to the "${drive.name}" drive${role ? ` as ${role}` : ''}`;
      break;
    case 'role_changed':
      notificationType = 'DRIVE_ROLE_CHANGED';
      title = `Role updated`;
      message = `Your role in "${drive.name}" has been changed${role ? ` to ${role}` : ''}`;
      break;
  }

  return createNotification({
    userId: targetUserId,
    type: notificationType,
    title,
    message,
    metadata: {
      driveName: drive.name,
      role,
    },
    driveId,
    triggeredByUserId,
  });
}

export async function createOrUpdateMessageNotification(
  targetUserId: string,
  conversationId: string,
  messagePreview: string,
  triggeredByUserId: string
) {
  // Check if there's an existing unread notification for this specific conversation
  const existingNotification = await db.query.notifications.findFirst({
    where: and(
      eq(notifications.userId, targetUserId),
      eq(notifications.type, 'NEW_DIRECT_MESSAGE'),
      eq(notifications.isRead, false),
      sql`${notifications.metadata}->>'conversationId' = ${conversationId}`
    ),
  });

  if (existingNotification) {
    // Update the existing notification with the new message
    const updatedNotification = await db
      .update(notifications)
      .set({
        message: messagePreview,
        createdAt: new Date(), // Update timestamp to show as recent
      })
      .where(eq(notifications.id, existingNotification.id))
      .returning();

    // Broadcast the updated notification
    await broadcastNotification(targetUserId, updatedNotification[0]);

    return updatedNotification[0];
  }

  // Create a new notification if none exists for this conversation
  return createNotification({
    userId: targetUserId,
    type: 'NEW_DIRECT_MESSAGE',
    title: 'New Direct Message',
    message: messagePreview,
    metadata: {
      conversationId,
    },
    triggeredByUserId,
  });
}
