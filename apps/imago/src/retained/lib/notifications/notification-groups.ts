import type { LegacyNotification } from '@pagespace/lib/notifications/types';

/** A notification as the store keeps it: the API's row plus its rendered copy. */
export type StoredNotification = LegacyNotification & { title: string; message: string };

/**
 * Types the board hides until PR #2871 lands (the orgs and wallets branch): the wallet-cap and
 * skipped-automation rows. They stay out of the popover, the page and its type chips.
 */
export const HIDDEN_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(['WALLET_CAP_ALERT', 'AUTOMATION_SKIPPED']);

export const isShownNotification = (notification: StoredNotification): boolean =>
  !HIDDEN_NOTIFICATION_TYPES.has(notification.type);

/** "CONNECTION_REQUEST" → "connection request", as the filter chips read. */
export const formatTypeLabel = (type: string): string => type.replace(/_/g, ' ').toLowerCase();

/** Midnight of the day `date` falls on, in local time. */
const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const daysBefore = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() - days);
  return copy;
};

/**
 * The bell's groups (C-Shell-Notifications): Today, Yesterday, then Older for everything
 * before yesterday. Empty groups are dropped, and order within a group is the store's.
 */
export const groupForBell = (
  notifications: readonly StoredNotification[],
  now: Date = new Date(),
): ReadonlyArray<readonly [string, StoredNotification[]]> => {
  const today = startOfDay(now);
  const yesterday = daysBefore(today, 1);
  const groups: Record<'Today' | 'Yesterday' | 'Older', StoredNotification[]> = {
    Today: [],
    Yesterday: [],
    Older: [],
  };
  for (const notification of notifications) {
    const at = new Date(notification.createdAt);
    if (at >= today) groups.Today.push(notification);
    else if (at >= yesterday) groups.Yesterday.push(notification);
    else groups.Older.push(notification);
  }
  return Object.entries(groups).filter(([, items]) => items.length > 0);
};

/**
 * The page's groups (C-Notifications): Today, Yesterday, This Week, This Month, then Older.
 */
export const groupForPage = (
  notifications: readonly StoredNotification[],
  now: Date = new Date(),
): ReadonlyArray<readonly [string, StoredNotification[]]> => {
  const today = startOfDay(now);
  const yesterday = daysBefore(today, 1);
  const weekAgo = daysBefore(today, 7);
  const monthAgo = new Date(today);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const groups: Record<'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older', StoredNotification[]> = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    'This Month': [],
    Older: [],
  };
  for (const notification of notifications) {
    const at = new Date(notification.createdAt);
    if (at >= today) groups.Today.push(notification);
    else if (at >= yesterday) groups.Yesterday.push(notification);
    else if (at >= weekAgo) groups['This Week'].push(notification);
    else if (at >= monthAgo) groups['This Month'].push(notification);
    else groups.Older.push(notification);
  }
  return Object.entries(groups).filter(([, items]) => items.length > 0);
};

/**
 * Where a row opens, in imago's own routes (basePath-relative). Classic's /dashboard paths do not
 * exist here. Null when the row names nothing to open.
 */
export const notificationHref = (notification: StoredNotification): string | null => {
  const { metadata, pageId, driveId, drive } = notification;
  if (notification.type === 'NEW_DIRECT_MESSAGE' && typeof metadata?.conversationId === 'string') {
    return `/dm/${encodeURIComponent(metadata.conversationId)}`;
  }
  if ((notification.type === 'MENTION' || notification.type === 'TASK_ASSIGNED') && pageId) {
    return `/p/${encodeURIComponent(pageId)}`;
  }
  const hereDrive = driveId ?? drive?.id ?? null;
  return hereDrive ? `/${encodeURIComponent(hereDrive)}` : null;
};
