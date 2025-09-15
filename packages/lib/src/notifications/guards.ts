// Type guard functions for notification types
import type {
  Notification,
  ConnectionRequestNotification,
  ConnectionAcceptedNotification,
  ConnectionRejectedNotification,
  NewDirectMessageNotification,
  PermissionGrantedNotification,
  PermissionUpdatedNotification,
  PermissionRevokedNotification,
  PageSharedNotification,
  DriveInvitedNotification,
  DriveJoinedNotification,
  DriveRoleChangedNotification,
  LegacyNotification,
} from './types';

// Connection-related guards
export function isConnectionRequest(
  notification: Notification | LegacyNotification
): notification is ConnectionRequestNotification {
  return notification.type === 'CONNECTION_REQUEST' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'connectionId' in notification.metadata;
}

export function isConnectionAccepted(
  notification: Notification | LegacyNotification
): notification is ConnectionAcceptedNotification {
  return notification.type === 'CONNECTION_ACCEPTED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'connectionId' in notification.metadata;
}

export function isConnectionRejected(
  notification: Notification | LegacyNotification
): notification is ConnectionRejectedNotification {
  return notification.type === 'CONNECTION_REJECTED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'connectionId' in notification.metadata;
}

// Message guards
export function isNewDirectMessage(
  notification: Notification | LegacyNotification
): notification is NewDirectMessageNotification {
  return notification.type === 'NEW_DIRECT_MESSAGE' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'conversationId' in notification.metadata;
}

// Permission guards
export function isPermissionGranted(
  notification: Notification | LegacyNotification
): notification is PermissionGrantedNotification {
  return notification.type === 'PERMISSION_GRANTED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'permissions' in notification.metadata;
}

export function isPermissionUpdated(
  notification: Notification | LegacyNotification
): notification is PermissionUpdatedNotification {
  return notification.type === 'PERMISSION_UPDATED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'permissions' in notification.metadata;
}

export function isPermissionRevoked(
  notification: Notification | LegacyNotification
): notification is PermissionRevokedNotification {
  return notification.type === 'PERMISSION_REVOKED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'permissions' in notification.metadata;
}

// Page guards
export function isPageShared(
  notification: Notification | LegacyNotification
): notification is PageSharedNotification {
  return notification.type === 'PAGE_SHARED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'permissions' in notification.metadata;
}

// Drive guards
export function isDriveInvited(
  notification: Notification | LegacyNotification
): notification is DriveInvitedNotification {
  return notification.type === 'DRIVE_INVITED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'driveName' in notification.metadata;
}

export function isDriveJoined(
  notification: Notification | LegacyNotification
): notification is DriveJoinedNotification {
  return notification.type === 'DRIVE_JOINED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'driveName' in notification.metadata;
}

export function isDriveRoleChanged(
  notification: Notification | LegacyNotification
): notification is DriveRoleChangedNotification {
  return notification.type === 'DRIVE_ROLE_CHANGED' &&
    notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    'driveName' in notification.metadata;
}

// Helper to check if a notification has a specific metadata field
export function hasMetadataField(
  notification: Notification | LegacyNotification,
  field: string
): boolean {
  return notification.metadata !== undefined &&
    typeof notification.metadata === 'object' &&
    field in notification.metadata;
}