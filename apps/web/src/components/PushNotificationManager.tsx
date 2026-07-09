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
    // 'denied': burn the attempt, do nothing — user must enable in iOS Settings.
  }, [isNative, isSupported, permissionStatus, isRegistered, requestPermission, registerToken]);

  return null;
}
