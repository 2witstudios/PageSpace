'use client';

import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { resolveDestination } from '@/lib/notifications/resolve-destination';
import { isToastEligible } from '@/lib/notifications/toast-eligible-types';
import { NotificationToast } from '@/components/notifications/NotificationToast';
import { useToastPreferences } from '@/hooks/useToastPreferences';
import { useNewStoreNotification } from '@/hooks/useNewStoreNotification';

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
  const { level } = useToastPreferences();

  useNewStoreNotification((top) => {
    if (!isToastEligible(top.type, level)) return;

    const destination = resolveDestination(top);
    if (destination && destination === pathname) return;

    const handleSelect = (toastId: string | number) => {
      if (!top.isRead) {
        handleNotificationRead(top.id);
      }
      if (destination) {
        router.push(destination);
      }
      toast.dismiss(toastId);
    };

    toast.custom(
      (id) => (
        <NotificationToast
          notification={top}
          onSelect={() => handleSelect(id)}
          onDismiss={() => toast.dismiss(id)}
        />
      ),
      { id: top.id, duration: 8000 },
    );
  });
}
