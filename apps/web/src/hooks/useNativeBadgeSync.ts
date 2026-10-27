'use client';

import { useEffect } from 'react';
import { useCapacitor } from './useCapacitor';
import { useAppStateRecovery } from './useAppStateRecovery';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { deriveBadgeCount } from '@pagespace/lib/notifications/derive-badge-count';
import type { Platform } from '@/lib/capacitor-bridge';

async function projectNativeBadge(unreadCount: number, platform: Platform): Promise<void> {
  try {
    const { Badge } = await import('@capawesome/capacitor-badge');
    // The permission gate below is iOS-only, and deliberately so. It is not a
    // general "check before you write" precaution; it defends against an
    // iOS-specific one-shot authorization cap, described below, that Android has
    // no analogue of. Android's badge is a launcher feature, and the plugin
    // declares its permission with no backing Android permission string
    // (`@CapacitorPlugin(name = "Badge", permissions = @Permission(strings = {},
    // alias = "display"))` in BadgePlugin.java), which Capacitor's
    // Bridge.getPermissionStates() answers as GRANTED unconditionally — so
    // running the gate there would be a native round trip that can only ever
    // return 'granted'. Keeping it conditional says which platform the hazard
    // belongs to instead of implying Android has one too.
    //
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
    if (platform === 'ios') {
      const permissions = await Badge.checkPermissions();
      if (permissions.display !== 'granted') return;
    }
    await Badge.set({ count: deriveBadgeCount(unreadCount) });
  } catch (error) {
    // Best-effort only — never let a missing/broken native plugin crash the app.
    // This is also the whole of Android's failure handling: launcher badge
    // support is optional there and many launchers reject or ignore the write,
    // so a rejection must stay a console line and never reach the user.
    console.error('[useNativeBadgeSync] Failed to project native badge:', error);
  }
}

/**
 * Projects `unreadCount` (the single source of truth) onto the native app-icon
 * badge, on every platform whose `badge` capability is true. Reactive:
 * re-projects on every store change and re-syncs
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
 * That second writer is the APNs `badge` field specifically, so the race is
 * iOS's; on Android the resume re-sync earns its place for the plainer reason
 * that the count can have moved on the server while the app was away.
 */
export function useNativeBadgeSync(): void {
  const { capabilities, platform, isReady } = useCapacitor();
  const canBadge = capabilities.badge;
  const unreadCount = useNotificationStore((state) => state.unreadCount);
  const hasHydrated = useNotificationStore((state) => state.hasHydrated);

  useEffect(() => {
    if (!isReady || !canBadge || !hasHydrated) return;
    void projectNativeBadge(unreadCount, platform);
  }, [isReady, canBadge, platform, hasHydrated, unreadCount]);

  useAppStateRecovery({
    onResume: async () => {
      await useNotificationStore.getState().fetchNotifications();
      await projectNativeBadge(useNotificationStore.getState().unreadCount, platform);
    },
    enabled: () => canBadge,
    minBackgroundTime: 0,
  });
}
