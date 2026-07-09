'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination, type StoredNotification } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { useToastPreferences } from '@/hooks/useToastPreferences';
import { isDesktopPlatform } from '@/lib/desktop-auth';

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
  const { level, isLoading: isLoadingPreferences } = useToastPreferences();

  const mountTimeRef = useRef(Date.now());
  const notifiedRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!isDesktopPlatform()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const unsubscribe = useNotificationStore.subscribe((state) => {
      const top = state.notifications[0] as StoredNotification | undefined;
      if (!top) return;
      const createdAt = new Date(top.createdAt);
      if (createdAt.getTime() < mountTimeRef.current) return;

      const signature = `${top.message}|${createdAt.toISOString()}`;
      if (notifiedRef.current.get(top.id) === signature) return;
      notifiedRef.current.set(top.id, signature);

      // Default to silence, not the provisional 'all', while the real
      // preference is still loading (e.g. on a cold start) — otherwise an
      // opted-out user could briefly see banners before their saved 'off'/
      // 'mentions' level has come back from the server.
      if (isLoadingPreferences) return;
      if (!isToastEligible(top.type, level)) return;
      if (document.hasFocus()) return;

      const n = new Notification(top.title, { body: top.message, tag: top.id });
      n.onclick = () => {
        window.focus();
        // Look up the live read state rather than the `top` closed over at
        // notification-construction time — it may have been marked read via
        // another surface (dropdown, sibling toast) in the meantime.
        const current = useNotificationStore.getState().notifications.find((notif) => notif.id === top.id);
        if (!current || !current.isRead) void handleNotificationRead(top.id);
        const destination = resolveDestination(top);
        if (destination) router.push(destination);
        n.close();
        // The sibling sonner toast (useNotificationToasts) may still be showing
        // for the same notification id — dismiss it so it doesn't linger after
        // the user has already navigated away via the OS notification.
        toast.dismiss(top.id);
      };
    });

    return unsubscribe;
  }, [router, handleNotificationRead, level, isLoadingPreferences]);
}
