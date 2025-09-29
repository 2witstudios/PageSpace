export * from './notifications/types';
export * from './notifications/guards';
export type NotificationType = 'PERMISSION_GRANTED' | 'PERMISSION_REVOKED' | 'PERMISSION_UPDATED' | 'PAGE_SHARED' | 'DRIVE_INVITED' | 'DRIVE_JOINED' | 'DRIVE_ROLE_CHANGED' | 'CONNECTION_REQUEST' | 'CONNECTION_ACCEPTED' | 'CONNECTION_REJECTED' | 'NEW_DIRECT_MESSAGE';
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
export declare function createNotification(params: CreateNotificationParams): Promise<{
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
}>;
export declare function getUserNotifications(userId: string, limit?: number): Promise<{
    triggeredByUser: {
        id: string;
        name: string;
        email: string;
        image: string | null;
    } | null;
    drive: {
        id: string;
        name: string;
        slug: string;
    } | null;
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
}[]>;
export declare function getUnreadNotificationCount(userId: string): Promise<number>;
export declare function markNotificationAsRead(notificationId: string, userId: string): Promise<{
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
}>;
export declare function markAllNotificationsAsRead(userId: string): Promise<void>;
export declare function deleteNotification(notificationId: string, userId: string): Promise<void>;
export declare function createPermissionNotification(targetUserId: string, pageId: string, type: 'granted' | 'updated' | 'revoked', permissions: {
    canView?: boolean;
    canEdit?: boolean;
    canShare?: boolean;
    canDelete?: boolean;
}, triggeredByUserId: string): Promise<{
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
} | null>;
export declare function createDriveNotification(targetUserId: string, driveId: string, type: 'invited' | 'joined' | 'role_changed', role?: string, triggeredByUserId?: string): Promise<{
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
} | null>;
export declare function createOrUpdateMessageNotification(targetUserId: string, conversationId: string, messagePreview: string, triggeredByUserId: string): Promise<{
    message: string;
    id: string;
    createdAt: Date;
    title: string;
    type: "PERMISSION_GRANTED" | "PERMISSION_REVOKED" | "PERMISSION_UPDATED" | "PAGE_SHARED" | "DRIVE_INVITED" | "DRIVE_JOINED" | "DRIVE_ROLE_CHANGED" | "CONNECTION_REQUEST" | "CONNECTION_ACCEPTED" | "CONNECTION_REJECTED" | "NEW_DIRECT_MESSAGE";
    driveId: string | null;
    pageId: string | null;
    userId: string;
    metadata: unknown;
    isRead: boolean;
    readAt: Date | null;
    triggeredByUserId: string | null;
}>;
//# sourceMappingURL=notifications.d.ts.map