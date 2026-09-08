'use client';

import { useEffect, useRef } from 'react';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { useCapacitor } from '@/hooks/useCapacitor';

export function PushNotificationManager() {
  const {
    isSupported,
    permissionStatus,
    requestPermission,
    registerToken,
    isRegistered
  } = usePushNotifications();

  const { isNative } = useCapacitor();
  const attemptRef = useRef(false);

  useEffect(() => {
    if (!isNative || !isSupported) return;
    // Wait until native checkPermissions() has resolved — don't burn the guard on 'unknown'.
    if (permissionStatus === 'unknown') return;
    // Prevent multiple attempts in strict mode dev
    if (attemptRef.current) return;
    attemptRef.current = true;

    if (permissionStatus === 'prompt') {
      void requestPermission();
    } else if (permissionStatus === 'granted' && !isRegistered) {
      void registerToken();
    }
    // Every other state burns the attempt and does nothing:
    // - 'denied': the OS will not ask again; the user must enable notifications
    //   in system settings.
    // - 'prompt-with-rationale' (Android only): the OS would still allow the
    //   ask, but the user has already refused once. Re-prompting here is exactly
    //   the every-launch nag the hook's recorded-denial guard exists to stop,
    //   and requestPermission() would decline it anyway.
  }, [isNative, isSupported, permissionStatus, isRegistered, requestPermission, registerToken]);

  return null;
}
