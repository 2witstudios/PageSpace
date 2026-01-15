import { db, notifications, users, pages, drives, eq, and, desc, count, sql } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { sendNotificationEmail } from '../services/notification-email-service';
import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';

// Export types and guards
export * from './types';
export * from './guards';
import type { NotificationType } from './types';

async function broadcastNotification(userId: string, notification: unknown) {
  try {
    const realtimeUrl = process.env.INTERNAL_REALTIME_URL || 'http://localhost:3001';
    const requestBody = JSON.stringify({
      channelId: `notifications:${userId}`,
      event: 'notification:new',
      payload: notification,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });
  } catch (error) {
    console.error('Failed to broadcast notification:', error);
  }
}

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

  // Send email notification (fire-and-forget - don't block on email sending)
  void sendNotificationEmail({
    userId: params.userId,
    notificationId: notification[0].id,
    type: params.type,
    metadata: params.metadata || {},
  });

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

  type NotificationResult = (typeof userNotifications)[number];

  return userNotifications.map((row: NotificationResult) => ({
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

// Alias for backward compatibility
export async function getUnreadCount(userId: string) {
  return getUnreadNotificationCount(userId);
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
      permissionList, // For email templates - array of strings like ['view', 'edit']
      pageName: page.title,
      pageTitle: page.title, // For email templates
      pageId, // For email templates
      driveName: page.drive?.name,
      driveId: page.driveId, // For email templates
      sharerName: triggeredByUser?.name || 'Someone', // For email templates
      adderName: triggeredByUser?.name || 'Someone', // For email templates
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
      title = `Added to workspace`;
      message = `${triggeredByUser?.name || 'Someone'} added you to the "${drive.name}" workspace`;
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
      driveId, // For email templates
      role,
      inviterName: triggeredByUser?.name || 'Someone', // For email templates
    },
    driveId,
    triggeredByUserId,
  });
}

export async function createOrUpdateMessageNotification(
  targetUserId: string,
  conversationId: string,
  messagePreview: string,
  triggeredByUserId: string,
  senderName?: string
) {
  // Get sender name if not provided
  if (!senderName) {
    const sender = await db.query.users.findFirst({
      where: eq(users.id, triggeredByUserId),
    });
    senderName = sender?.name || 'Someone';
  }

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

    // Send email notification for the updated message
    void sendNotificationEmail({
      userId: targetUserId,
      notificationId: updatedNotification[0].id,
      type: 'NEW_DIRECT_MESSAGE',
      metadata: {
        conversationId,
        senderName,
        messagePreview,
      },
    });

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
      senderName, // For email template
      messagePreview, // For email template
    },
    triggeredByUserId,
  });
}

/**
 * Creates a notification when a user is @mentioned in a page
 */
export async function createMentionNotification(
  targetUserId: string,
  pageId: string,
  triggeredByUserId: string
) {
  // Don't notify users who mention themselves
  if (targetUserId === triggeredByUserId) return null;

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

  const mentionerName = triggeredByUser?.name || 'Someone';

  return createNotification({
    userId: targetUserId,
    type: 'MENTION',
    title: 'You were mentioned',
    message: `${mentionerName} mentioned you in "${page.title}"`,
    metadata: {
      pageTitle: page.title,
      pageType: page.type,
      driveName: page.drive?.name,
      driveSlug: page.drive?.slug,
      mentionerName,
    },
    pageId,
    driveId: page.driveId,
    triggeredByUserId,
  });
}

/**
 * Creates a notification when a user is assigned to a task
 */
export async function createTaskAssignedNotification(
  targetUserId: string,
  taskId: string,
  taskTitle: string,
  taskListPageId: string,
  triggeredByUserId: string
) {
  // Don't notify users who assign tasks to themselves
  if (targetUserId === triggeredByUserId) return null;

  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, taskListPageId),
    with: {
      drive: true,
    },
  });

  if (!taskListPage) return null;

  const triggeredByUser = await db.query.users.findFirst({
    where: eq(users.id, triggeredByUserId),
  });

  const assignerName = triggeredByUser?.name || 'Someone';

  return createNotification({
    userId: targetUserId,
    type: 'TASK_ASSIGNED',
    title: 'Task assigned to you',
    message: `${assignerName} assigned you to "${taskTitle}"`,
    metadata: {
      taskId,
      taskTitle,
      taskListPageId,
      taskListPageTitle: taskListPage.title,
      driveName: taskListPage.drive?.name,
      driveSlug: taskListPage.drive?.slug,
      assignerName,
    },
    pageId: taskListPageId,
    driveId: taskListPage.driveId,
    triggeredByUserId,
  });
}

/**
 * Broadcasts TOS/Privacy update notifications to all users
 * @param documentType - The type of document that was updated ('tos' | 'privacy')
 * @param documentUrl - The URL to the updated document (e.g., '/terms' or '/privacy')
 */
export async function broadcastTosPrivacyUpdate(
  documentType: 'tos' | 'privacy'
) {
  try {
    // Get all active users (users with verified emails or at least one login)
    const allUsers = await db.select({ id: users.id }).from(users);

    const title = documentType === 'tos'
      ? 'Terms of Service Updated'
      : 'Privacy Policy Updated';

    const message = documentType === 'tos'
      ? 'Our Terms of Service have been updated. Please review the changes.'
      : 'Our Privacy Policy has been updated. Please review the changes.';

    const documentUrl = documentType === 'tos' ? '/terms' : '/privacy';

    // Create notifications for all users
    const notificationPromises = allUsers.map(user =>
      createNotification({
        userId: user.id,
        type: 'TOS_PRIVACY_UPDATED',
        title,
        message,
        metadata: {
          documentType,
          documentUrl,
          updatedAt: new Date().toISOString(),
        },
      })
    );

    await Promise.all(notificationPromises);

    return {
      success: true,
      notifiedUsers: allUsers.length,
    };
  } catch (error) {
    console.error('Failed to broadcast TOS/Privacy update:', error);
    throw error;
  }
}
