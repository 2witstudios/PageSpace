"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = createNotification;
exports.getUserNotifications = getUserNotifications;
exports.getUnreadNotificationCount = getUnreadNotificationCount;
exports.markNotificationAsRead = markNotificationAsRead;
exports.markAllNotificationsAsRead = markAllNotificationsAsRead;
exports.deleteNotification = deleteNotification;
exports.createPermissionNotification = createPermissionNotification;
exports.createDriveNotification = createDriveNotification;
exports.createOrUpdateMessageNotification = createOrUpdateMessageNotification;
const db_1 = require("@pagespace/db");
const cuid2_1 = require("@paralleldrive/cuid2");
// Export types and guards
__exportStar(require("./notifications/types"), exports);
__exportStar(require("./notifications/guards"), exports);
async function broadcastNotification(userId, notification) {
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
    }
    catch (error) {
        console.error('Failed to broadcast notification:', error);
    }
}
async function createNotification(params) {
    const notification = await db_1.db.insert(db_1.notifications).values({
        id: (0, cuid2_1.createId)(),
        ...params,
    }).returning();
    // Broadcast notification to user via Socket.IO
    await broadcastNotification(params.userId, notification[0]);
    return notification[0];
}
async function getUserNotifications(userId, limit = 50) {
    const userNotifications = await db_1.db
        .select({
        notification: db_1.notifications,
        triggeredByUser: {
            id: db_1.users.id,
            name: db_1.users.name,
            email: db_1.users.email,
            image: db_1.users.image,
        },
        drive: {
            id: db_1.drives.id,
            slug: db_1.drives.slug,
            name: db_1.drives.name,
        },
    })
        .from(db_1.notifications)
        .leftJoin(db_1.users, (0, db_1.eq)(db_1.notifications.triggeredByUserId, db_1.users.id))
        .leftJoin(db_1.drives, (0, db_1.eq)(db_1.notifications.driveId, db_1.drives.id))
        .where((0, db_1.eq)(db_1.notifications.userId, userId))
        .orderBy((0, db_1.desc)(db_1.notifications.createdAt))
        .limit(limit);
    return userNotifications.map((row) => ({
        ...row.notification,
        triggeredByUser: row.triggeredByUser,
        drive: row.drive,
    }));
}
async function getUnreadNotificationCount(userId) {
    const result = await db_1.db
        .select({ count: (0, db_1.count)() })
        .from(db_1.notifications)
        .where((0, db_1.and)((0, db_1.eq)(db_1.notifications.userId, userId), (0, db_1.eq)(db_1.notifications.isRead, false)));
    return Number(result[0]?.count || 0);
}
async function markNotificationAsRead(notificationId, userId) {
    const updated = await db_1.db
        .update(db_1.notifications)
        .set({
        isRead: true,
        readAt: new Date(),
    })
        .where((0, db_1.and)((0, db_1.eq)(db_1.notifications.id, notificationId), (0, db_1.eq)(db_1.notifications.userId, userId)))
        .returning();
    return updated[0];
}
async function markAllNotificationsAsRead(userId) {
    await db_1.db
        .update(db_1.notifications)
        .set({
        isRead: true,
        readAt: new Date(),
    })
        .where((0, db_1.and)((0, db_1.eq)(db_1.notifications.userId, userId), (0, db_1.eq)(db_1.notifications.isRead, false)));
}
async function deleteNotification(notificationId, userId) {
    await db_1.db
        .delete(db_1.notifications)
        .where((0, db_1.and)((0, db_1.eq)(db_1.notifications.id, notificationId), (0, db_1.eq)(db_1.notifications.userId, userId)));
}
async function createPermissionNotification(targetUserId, pageId, type, permissions, triggeredByUserId) {
    const page = await db_1.db.query.pages.findFirst({
        where: (0, db_1.eq)(db_1.pages.id, pageId),
        with: {
            drive: true,
        },
    });
    if (!page)
        return null;
    const triggeredByUser = await db_1.db.query.users.findFirst({
        where: (0, db_1.eq)(db_1.users.id, triggeredByUserId),
    });
    const permissionList = [];
    if (permissions.canView)
        permissionList.push('view');
    if (permissions.canEdit)
        permissionList.push('edit');
    if (permissions.canShare)
        permissionList.push('share');
    if (permissions.canDelete)
        permissionList.push('delete');
    let notificationType;
    let title;
    let message;
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
async function createDriveNotification(targetUserId, driveId, type, role, triggeredByUserId) {
    const drive = await db_1.db.query.drives.findFirst({
        where: (0, db_1.eq)(db_1.drives.id, driveId),
    });
    if (!drive)
        return null;
    const triggeredByUser = triggeredByUserId ? await db_1.db.query.users.findFirst({
        where: (0, db_1.eq)(db_1.users.id, triggeredByUserId),
    }) : null;
    let notificationType;
    let title;
    let message;
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
async function createOrUpdateMessageNotification(targetUserId, conversationId, messagePreview, triggeredByUserId) {
    // Check if there's an existing unread notification for this specific conversation
    const existingNotification = await db_1.db.query.notifications.findFirst({
        where: (0, db_1.and)((0, db_1.eq)(db_1.notifications.userId, targetUserId), (0, db_1.eq)(db_1.notifications.type, 'NEW_DIRECT_MESSAGE'), (0, db_1.eq)(db_1.notifications.isRead, false), (0, db_1.sql) `${db_1.notifications.metadata}->>'conversationId' = ${conversationId}`),
    });
    if (existingNotification) {
        // Update the existing notification with the new message
        const updatedNotification = await db_1.db
            .update(db_1.notifications)
            .set({
            message: messagePreview,
            createdAt: new Date(), // Update timestamp to show as recent
        })
            .where((0, db_1.eq)(db_1.notifications.id, existingNotification.id))
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
