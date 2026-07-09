'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination, type StoredNotification } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { useToastPreferences } from '@/hooks/useToastPreferences';

/**
 * Shows a native OS notification (Electron desktop only) whenever a new (or
 * updated-in-place) notification lands in useNotificationStore, but only
 * when the window is unfocused — a focused window is already covered by the
 * sonner toast from useNotificationToasts, so showing both would double-notify.
 *
 * Deliberately does NOT add its own socket listener; useNotificationStore is
 * the single parse/dedup source of truth, mirroring useNotificationToasts.
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

      const n = new Notification(top.title, { body: top.message, tag: top.id });
      n.onclick = () => {
        window.focus();
        if (!top.isRead) void handleNotificationRead(top.id);
        const destination = resolveDestination(top);
        if (destination) router.push(destination);
        n.close();
      };
    });

    return unsubscribe;
  }, [router, handleNotificationRead, level]);
}
