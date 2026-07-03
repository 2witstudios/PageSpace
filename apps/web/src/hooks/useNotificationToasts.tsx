'use client';

import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination, type StoredNotification } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { NotificationToast } from '@/components/notifications/NotificationToast';

/**
 * Shows a live custom toast whenever a new (or updated-in-place, e.g.
 * NEW_DIRECT_MESSAGE) notification lands in useNotificationStore.
 *
 * Deliberately does NOT add its own socket.on('notification:new') listener.
 * useNotificationStore.initializeSocketListeners() (wired up from
 * NotificationBell) is the single source of truth for parsing/deduping
 * incoming notifications; this hook reacts to the resulting store state so
 * the toast and the dropdown/badge can never disagree or double-toast.
 */
export function useNotificationToasts() {
  const router = useRouter();
  const pathname = usePathname();
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);

  const mountTimeRef = useRef(Date.now());
  const toastedRef = useRef(new Map<string, string>());

  useEffect(() => {
    const handleSelect = (notification: StoredNotification, toastId: string | number) => {
      if (!notification.isRead) {
        handleNotificationRead(notification.id);
      }
      const destination = resolveDestination(notification);
      if (destination) {
        router.push(destination);
      }
      toast.dismiss(toastId);
    };

    const unsubscribe = useNotificationStore.subscribe((state) => {
      const top = state.notifications[0] as StoredNotification | undefined;
      if (!top) return;
      if (new Date(top.createdAt).getTime() < mountTimeRef.current) return;

      const signature = `${top.message}|${new Date(top.createdAt).toISOString()}`;
      if (toastedRef.current.get(top.id) === signature) return;
      toastedRef.current.set(top.id, signature);

      if (!isToastEligible(top.type)) return;

      const destination = resolveDestination(top);
      if (destination && destination === pathname) return;

      toast.custom(
        (id) => (
          <NotificationToast
            notification={top}
            onSelect={() => handleSelect(top, id)}
            onDismiss={() => toast.dismiss(id)}
          />
        ),
        { id: top.id, duration: 8000 },
      );
    });

    return unsubscribe;
  }, [router, pathname, handleNotificationRead]);
}
