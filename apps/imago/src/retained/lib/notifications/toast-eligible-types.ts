import type { NotificationType } from '@pagespace/lib/notifications/types';

// EMAIL_VERIFICATION_REQUIRED: a persistent system nag already surfaced via
// account settings; a transient, dismissible toast risks the user losing it.
// TOS_PRIVACY_UPDATED: a compliance notice broadcast to all users; it should
// stay as a persistent dropdown/notifications-page item until explicitly
// read, not a toast that can vanish/be missed.
export const TOAST_EXCLUDED_TYPES: ReadonlySet<NotificationType> = new Set([
  'EMAIL_VERIFICATION_REQUIRED',
  'TOS_PRIVACY_UPDATED',
]);

export type ToastNotificationLevel = 'all' | 'mentions' | 'off';

// Types treated as "directly involves you" for the Mentions & DMs tier —
// the PageSpace analog of Discord/Slack's "@mentions only" notification level.
export const TOAST_HIGH_SIGNAL_TYPES: ReadonlySet<NotificationType> = new Set([
  'MENTION',
  'NEW_DIRECT_MESSAGE',
  'TASK_ASSIGNED',
  'CONNECTION_REQUEST',
]);

export function isToastEligible(type: string, level: ToastNotificationLevel = 'all'): boolean {
  if (level === 'off') return false;
  if (TOAST_EXCLUDED_TYPES.has(type as NotificationType)) return false;
  if (level === 'mentions' && !TOAST_HIGH_SIGNAL_TYPES.has(type as NotificationType)) return false;
  return true;
}
