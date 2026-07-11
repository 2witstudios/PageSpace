'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { useToastPreferences } from '@/hooks/useToastPreferences';
import { isDesktopPlatform } from '@/lib/desktop-auth';
import { useNewStoreNotification } from '@/hooks/useNewStoreNotification';

/**
 * Shows a native OS notification (Electron desktop only) whenever a new (or
 * updated-in-place) notification lands in useNotificationStore, but only
 * when the window is unfocused — a focused window is already covered by the
 * sonner toast from useNotificationToasts, so showing both would double-notify.
 *
 * Shares its "is this event worth considering" gate with useNotificationToasts
 * via useNewStoreNotification so the two surfaces can never disagree about
 * what counts as new.
 */
export function useDesktopNotifications() {
  const router = useRouter();
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);
  const { level, isLoading: isLoadingPreferences } = useToastPreferences();

  const canShowDesktopNotifications =
    isDesktopPlatform() && typeof Notification !== 'undefined' && Notification.permission === 'granted';

  useNewStoreNotification((top) => {
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
  }, canShowDesktopNotifications);
}
