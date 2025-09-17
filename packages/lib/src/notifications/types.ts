// Type definitions for the notification system with discriminated unions

// User and Drive info types
export interface UserInfo {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
}

export interface DriveInfo {
  id: string;
  slug: string;
  name: string;
}

// Base notification structure shared by all notification types
export interface NotificationBase {
  id: string;
  userId: string;
  isRead: boolean;
  createdAt: Date;
  readAt?: Date | null;
  pageId?: string | null;
  driveId?: string | null;
  triggeredByUserId?: string | null;
  triggeredByUser?: UserInfo | null;
  drive?: DriveInfo | null;
}

// Connection-related notifications
export type ConnectionRequestNotification = NotificationBase & {
  type: 'CONNECTION_REQUEST';
  title: string;
  message: string;
  metadata: {
    connectionId: string;
    senderId: string;
    requestMessage?: string;
  };
};

export type ConnectionAcceptedNotification = NotificationBase & {
  type: 'CONNECTION_ACCEPTED';
  title: string;
  message: string;
  metadata: {
    connectionId: string;
    acceptedByUserId: string;
  };
};

export type ConnectionRejectedNotification = NotificationBase & {
  type: 'CONNECTION_REJECTED';
  title: string;
  message: string;
  metadata: {
    connectionId: string;
    rejectedByUserId: string;
  };
};

// Message notifications
export type NewDirectMessageNotification = NotificationBase & {
  type: 'NEW_DIRECT_MESSAGE';
  title: string;
  message: string;
  metadata: {
    conversationId: string;
    messageId: string;
    senderId: string;
    preview?: string;
  };
};

// Permission-related notifications
export type PermissionGrantedNotification = NotificationBase & {
  type: 'PERMISSION_GRANTED';
  title: string;
  message: string;
  metadata: {
    permissions: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageName: string;
    driveName?: string;
  };
};

export type PermissionUpdatedNotification = NotificationBase & {
  type: 'PERMISSION_UPDATED';
  title: string;
  message: string;
  metadata: {
    permissions: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageName: string;
    driveName?: string;
  };
};

export type PermissionRevokedNotification = NotificationBase & {
  type: 'PERMISSION_REVOKED';
  title: string;
  message: string;
  metadata: {
    permissions: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageName: string;
    driveName?: string;
  };
};

// Page-related notifications
export type PageSharedNotification = NotificationBase & {
  type: 'PAGE_SHARED';
  title: string;
  message: string;
  metadata: {
    permissions: {
      canView?: boolean;
      canEdit?: boolean;
      canShare?: boolean;
      canDelete?: boolean;
    };
    pageName: string;
    driveName?: string;
  };
};

// Drive-related notifications
export type DriveInvitedNotification = NotificationBase & {
  type: 'DRIVE_INVITED';
  title: string;
  message: string;
  metadata: {
    driveName: string;
    role?: string;
  };
};

export type DriveJoinedNotification = NotificationBase & {
  type: 'DRIVE_JOINED';
  title: string;
  message: string;
  metadata: {
    driveName: string;
    role?: string;
  };
};

export type DriveRoleChangedNotification = NotificationBase & {
  type: 'DRIVE_ROLE_CHANGED';
  title: string;
  message: string;
  metadata: {
    driveName: string;
    role?: string;
    previousRole?: string;
  };
};

// Union of all notification types
export type Notification =
  | ConnectionRequestNotification
  | ConnectionAcceptedNotification
  | ConnectionRejectedNotification
  | NewDirectMessageNotification
  | PermissionGrantedNotification
  | PermissionUpdatedNotification
  | PermissionRevokedNotification
  | PageSharedNotification
  | DriveInvitedNotification
  | DriveJoinedNotification
  | DriveRoleChangedNotification;

// Type for notification types
export type NotificationType = Notification['type'];

// For backward compatibility with existing code
export interface LegacyNotification extends NotificationBase {
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}