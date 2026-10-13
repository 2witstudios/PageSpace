import { isImagoEnabled } from '@/lib/imago/imago-enabled';

/** Human labels for each emailable notification type, shared by /unsubscribe and /unsubscribe-success. */
export const NOTIFICATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  PERMISSION_GRANTED: 'Collaborator Added',
  PERMISSION_REVOKED: 'Permission Revoked',
  PERMISSION_UPDATED: 'Permission Updated',
  PAGE_SHARED: 'Page Shared',
  DRIVE_INVITED: 'Workspace Additions',
  DRIVE_JOINED: 'Drive Joined',
  DRIVE_ROLE_CHANGED: 'Drive Role Changed',
  CONNECTION_REQUEST: 'Connection Requests',
  CONNECTION_ACCEPTED: 'Connection Accepted',
  CONNECTION_REJECTED: 'Connection Rejected',
  NEW_DIRECT_MESSAGE: 'Direct Messages',
  PRODUCT_UPDATE: 'Product Updates',
};

/** Where "manage preferences" links point: the v3 account page when Imago is enabled. */
export function getNotificationPreferencesHref(): string {
  return isImagoEnabled() ? '/imago/account/notifications' : '/settings/notifications';
}
