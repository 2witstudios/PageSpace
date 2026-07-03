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

export function isToastEligible(type: string): boolean {
  return !TOAST_EXCLUDED_TYPES.has(type as NotificationType);
}
