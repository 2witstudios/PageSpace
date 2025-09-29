import type { Notification, ConnectionRequestNotification, ConnectionAcceptedNotification, ConnectionRejectedNotification, NewDirectMessageNotification, PermissionGrantedNotification, PermissionUpdatedNotification, PermissionRevokedNotification, PageSharedNotification, DriveInvitedNotification, DriveJoinedNotification, DriveRoleChangedNotification, LegacyNotification } from './types';
export declare function isConnectionRequest(notification: Notification | LegacyNotification): notification is ConnectionRequestNotification;
export declare function isConnectionAccepted(notification: Notification | LegacyNotification): notification is ConnectionAcceptedNotification;
export declare function isConnectionRejected(notification: Notification | LegacyNotification): notification is ConnectionRejectedNotification;
export declare function isNewDirectMessage(notification: Notification | LegacyNotification): notification is NewDirectMessageNotification;
export declare function isPermissionGranted(notification: Notification | LegacyNotification): notification is PermissionGrantedNotification;
export declare function isPermissionUpdated(notification: Notification | LegacyNotification): notification is PermissionUpdatedNotification;
export declare function isPermissionRevoked(notification: Notification | LegacyNotification): notification is PermissionRevokedNotification;
export declare function isPageShared(notification: Notification | LegacyNotification): notification is PageSharedNotification;
export declare function isDriveInvited(notification: Notification | LegacyNotification): notification is DriveInvitedNotification;
export declare function isDriveJoined(notification: Notification | LegacyNotification): notification is DriveJoinedNotification;
export declare function isDriveRoleChanged(notification: Notification | LegacyNotification): notification is DriveRoleChangedNotification;
export declare function hasMetadataField(notification: Notification | LegacyNotification, field: string): boolean;
//# sourceMappingURL=guards.d.ts.map