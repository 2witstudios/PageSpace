'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination, type StoredNotification } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { useToastPreferences } from '@/hooks/useToastPreferences';

/**
 * Shows a native OS notification (Electron desktop only) whenever a new
 * notification lands in useNotificationStore, mirroring useNotificationToasts'
 * store-subscription/dedup pattern rather than listening to the socket directly.
 *
 * Unlike the in-app toast, this fires even when the destination matches the
 * current pathname: an unfocused window means the user hasn't actually seen it.
 */
export function useDesktopNotifications() {
  const router = useRouter();
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);
  const { level } = useToastPreferences();

  const mountTimeRef = useRef(Date.now());
  const notifiedRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.isDesktop) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const unsubscribe = useNotificationStore.subscribe((state) => {
      const top = state.notifications[0] as StoredNotification | undefined;
      if (!top) return;
      if (new Date(top.createdAt).getTime() < mountTimeRef.current) return;

      const signature = `${top.message}|${new Date(top.createdAt).toISOString()}`;
      if (notifiedRef.current.get(top.id) === signature) return;
      notifiedRef.current.set(top.id, signature);

      if (!isToastEligible(top.type, level)) return;
      if (document.hasFocus()) return;

      const notification = new Notification(top.title, { body: top.message, tag: top.id });
      notification.onclick = () => {
        window.focus();
        if (!top.isRead) {
          void handleNotificationRead(top.id);
        }
        const destination = resolveDestination(top);
        if (destination) {
          router.push(destination);
        }
        notification.close();
      };
    });

    return unsubscribe;
  }, [router, handleNotificationRead, level]);
}
