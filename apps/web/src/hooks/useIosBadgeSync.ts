'use client';

import { useEffect } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAppStateRecovery } from './useAppStateRecovery';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { deriveBadgeCount } from '@pagespace/lib/notifications/derive-badge-count';

async function projectNativeBadge(unreadCount: number): Promise<void> {
  try {
    const { Badge } = await import('@capawesome/capacitor-badge');
    // Badge.set() internally calls UNUserNotificationCenter.requestAuthorization(
    // options: .badge) before writing the count (see @capawesome/capacitor-badge's
    // ios/Plugin/Badge.swift). iOS shows the permission prompt only once per
    // install and permanently caps the granted option set to whatever the FIRST
    // request ever asked for, with no re-prompt — so if this badge-only request
    // won the race against PushNotificationManager's broader
    // [.alert, .badge, .sound] request, alert/sound notifications could be
    // silently disabled forever. checkPermissions() reads the current status
    // WITHOUT prompting, so gating on it here guarantees Badge.set() can never
    // itself be the first-ever authorization request — by the time badge
    // permission reads as granted, the push flow's broader request already
    // decided the option set.
    const permissions = await Badge.checkPermissions();
    if (permissions.display !== 'granted') return;
    await Badge.set({ count: deriveBadgeCount(unreadCount) });
  } catch (error) {
    // Best-effort only — never let a missing/broken native plugin crash the app.
    console.error('[useIosBadgeSync] Failed to project native badge:', error);
  }
}

/**
 * Projects `unreadCount` (the single source of truth) onto the native iOS
 * app-icon badge. Reactive: re-projects on every store change and re-syncs
 * from the server on app resume, instead of relying on the lossy APNs
 * silent push to teach the client the truth (which is why the badge used to
 * get stuck).
 *
 * Waits for `hasHydrated` before projecting anything: the store defaults to
 * unreadCount 0 before its first successful fetch resolves, and projecting
 * that default would incorrectly zero a possibly-nonzero badge on cold
 * launch (or during the auth-bootstrap window).
 *
 * Re-projects explicitly after the resume-triggered fetch (rather than
 * relying solely on the reactive effect below) because the silent push
 * stays a second, best-effort writer to the same native badge — an
 * unrelated silent push could have overwritten it correctly-but-stale value
 * while the app was backgrounded, even if unreadCount itself hasn't changed.
 */
export function useIosBadgeSync(): void {
  const { isIOS, isReady } = useCapacitor();
  const unreadCount = useNotificationStore((state) => state.unreadCount);
  const hasHydrated = useNotificationStore((state) => state.hasHydrated);

  useEffect(() => {
    if (!isReady || !isIOS || !hasHydrated) return;
    void projectNativeBadge(unreadCount);
  }, [isReady, isIOS, hasHydrated, unreadCount]);

  useAppStateRecovery({
    onResume: async () => {
      await useNotificationStore.getState().fetchNotifications();
      await projectNativeBadge(useNotificationStore.getState().unreadCount);
    },
    enabled: () => isIOS,
    minBackgroundTime: 0,
  });
}
