'use client';

import { useEffect } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAppStateRecovery } from './useAppStateRecovery';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { deriveBadgeCount } from '@pagespace/lib/notifications/derive-badge-count';

async function projectNativeBadge(unreadCount: number): Promise<void> {
  try {
    const { Badge } = await import('@capawesome/capacitor-badge');
    await Badge.set({ count: deriveBadgeCount(unreadCount) });
  } catch {
    // Badge plugin unsupported/unavailable on this device — best effort only.
  }
}

/**
 * Projects `unreadCount` (the single source of truth) onto the native iOS
 * app-icon badge. Reactive: re-projects on every store change and re-syncs
 * from the server on app resume, instead of relying on the lossy APNs
 * silent push to teach the client the truth (which is why the badge used to
 * get stuck).
 */
export function useIosBadgeSync(): void {
  const { isIOS, isReady } = useCapacitor();
  const unreadCount = useNotificationStore((state) => state.unreadCount);

  useEffect(() => {
    if (typeof window === 'undefined' || !isReady || !isIOS) return;
    void projectNativeBadge(unreadCount);
  }, [isReady, isIOS, unreadCount]);

  useAppStateRecovery({
    onResume: async () => {
      await useNotificationStore.getState().fetchNotifications();
      await projectNativeBadge(useNotificationStore.getState().unreadCount);
    },
    enabled: () => isIOS,
    minBackgroundTime: 0,
  });
}
