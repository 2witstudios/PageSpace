'use client';

import useSWR from 'swr';
import { useSocketEvent } from '@/realtime/realtime-provider';

/** apps/web's unread-notification count, the bell's badge (CANON: "3" on every board). */
export const NOTIFICATION_COUNT = '/api/notifications?countOnly=true';

/** The count from `{ count }`, or 0 for anything that is not one. */
export const notificationCount = (body: unknown): number => {
  if (typeof body !== 'object' || body === null) return 0;
  const { count } = body as { readonly count?: unknown };
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/**
 * The bell's unread count, refetched whenever a notification arrives (realtime emits only
 * notification:new; marking read refreshes it from the notifications popover, phase 9).
 */
export const useNotificationCount = (): number => {
  const { data, mutate } = useSWR<unknown>(NOTIFICATION_COUNT);
  const refresh = () => void mutate();
  useSocketEvent('notification:new', refresh);
  return notificationCount(data);
};
