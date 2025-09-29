"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConnectionRequest = isConnectionRequest;
exports.isConnectionAccepted = isConnectionAccepted;
exports.isConnectionRejected = isConnectionRejected;
exports.isNewDirectMessage = isNewDirectMessage;
exports.isPermissionGranted = isPermissionGranted;
exports.isPermissionUpdated = isPermissionUpdated;
exports.isPermissionRevoked = isPermissionRevoked;
exports.isPageShared = isPageShared;
exports.isDriveInvited = isDriveInvited;
exports.isDriveJoined = isDriveJoined;
exports.isDriveRoleChanged = isDriveRoleChanged;
exports.hasMetadataField = hasMetadataField;
// Connection-related guards
function isConnectionRequest(notification) {
    return notification.type === 'CONNECTION_REQUEST' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'connectionId' in notification.metadata;
}
function isConnectionAccepted(notification) {
    return notification.type === 'CONNECTION_ACCEPTED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'connectionId' in notification.metadata;
}
function isConnectionRejected(notification) {
    return notification.type === 'CONNECTION_REJECTED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'connectionId' in notification.metadata;
}
// Message guards
function isNewDirectMessage(notification) {
    return notification.type === 'NEW_DIRECT_MESSAGE' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'conversationId' in notification.metadata;
}
// Permission guards
function isPermissionGranted(notification) {
    return notification.type === 'PERMISSION_GRANTED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'permissions' in notification.metadata;
}
function isPermissionUpdated(notification) {
    return notification.type === 'PERMISSION_UPDATED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'permissions' in notification.metadata;
}
function isPermissionRevoked(notification) {
    return notification.type === 'PERMISSION_REVOKED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'permissions' in notification.metadata;
}
// Page guards
function isPageShared(notification) {
    return notification.type === 'PAGE_SHARED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'permissions' in notification.metadata;
}
// Drive guards
function isDriveInvited(notification) {
    return notification.type === 'DRIVE_INVITED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'driveName' in notification.metadata;
}
function isDriveJoined(notification) {
    return notification.type === 'DRIVE_JOINED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'driveName' in notification.metadata;
}
function isDriveRoleChanged(notification) {
    return notification.type === 'DRIVE_ROLE_CHANGED' &&
        notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        'driveName' in notification.metadata;
}
// Helper to check if a notification has a specific metadata field
function hasMetadataField(notification, field) {
    return notification.metadata !== undefined &&
        typeof notification.metadata === 'object' &&
        field in notification.metadata;
}
