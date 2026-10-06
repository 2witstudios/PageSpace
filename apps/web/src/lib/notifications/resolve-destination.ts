import { type LegacyNotification } from '@pagespace/lib/notifications/types';

export type StoredNotification = LegacyNotification & { title: string; message: string };

export function resolveDestination(notification: StoredNotification): string | null {
  if (notification.type === 'EMAIL_VERIFICATION_REQUIRED') {
    return '/settings/account';
  }

  if (
    notification.type === 'TOS_PRIVACY_UPDATED' &&
    notification.metadata &&
    typeof notification.metadata === 'object' &&
    'documentUrl' in notification.metadata &&
    typeof notification.metadata.documentUrl === 'string'
  ) {
    return notification.metadata.documentUrl;
  }

  if (
    notification.type === 'NEW_DIRECT_MESSAGE' &&
    notification.metadata &&
    typeof notification.metadata === 'object' &&
    'conversationId' in notification.metadata &&
    typeof notification.metadata.conversationId === 'string'
  ) {
    return `/dashboard/dms/${notification.metadata.conversationId}`;
  }

  if (
    (notification.type === 'MENTION' || notification.type === 'TASK_ASSIGNED') &&
    notification.pageId &&
    notification.driveId
  ) {
    return `/dashboard/${notification.driveId}/${notification.pageId}`;
  }

  // WAL-7 / WAL-6e: a cap alert or a debt notice opens the wallet it is about — a drive's
  // Wallet settings, or (a seat or pool, no drive) Settings › Usage › Wallets.
  if (notification.type === 'WALLET_CAP_ALERT' || notification.type === 'WALLET_DEBT') {
    return notification.driveId ? `/dashboard/${notification.driveId}/settings/wallet` : '/settings/usage/wallets';
  }

  // SPEND-6: a skipped automation opens the drive's workflows, where the run says why.
  if (notification.type === 'AUTOMATION_SKIPPED' && notification.driveId) {
    return `/dashboard/${notification.driveId}/workflows`;
  }

  if (notification.drive?.id) {
    return `/dashboard/${notification.drive.id}`;
  }

  return null;
}
