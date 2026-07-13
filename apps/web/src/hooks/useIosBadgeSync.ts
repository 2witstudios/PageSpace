'use client';

import { useEffect } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAppStateRecovery } from './useAppStateRecovery';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { deriveBadgeCount } from '@pagespace/lib/notifications/derive-badge-count';

async function projectNativeBadge(unreadCount: number): Promise<void> {
  try {
    // NOTE: on iOS, Badge.set() internally calls
    // UNUserNotificationCenter.requestAuthorization(options: .badge) before
    // writing the count (see @capawesome/capacitor-badge's ios/Plugin/Badge.swift).
    // iOS only ever shows the permission prompt once per install and honors
    // whichever options were in the FIRST request an app ever makes — so if this
    // badge-only request somehow raced ahead of PushNotificationManager's broader
    // [.alert, .badge, .sound] request, alert/sound could be silently capped forever
    // with no re-prompt. In practice this hook's Badge.set() only runs after
    // `hasHydrated` (a completed /api/notifications network round trip), which is
    // far slower than PushNotificationManager's native-bridge-only permission
    // check+request, so the push flow wins in all observed conditions. Flagged for
    // device verification during TestFlight rather than fixed here, since resolving
    // it for certain would mean coordinating with usePushNotifications/
    // PushNotificationManager — out of this PR's scope.
    const { Badge } = await import('@capawesome/capacitor-badge');
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
