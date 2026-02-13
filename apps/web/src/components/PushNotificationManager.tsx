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

    // Prevent multiple attempts in strict mode dev
    if (attemptRef.current) return;
    attemptRef.current = true;

    const initNotifications = async () => {
      if (permissionStatus === 'prompt') {
        await requestPermission();
      } else if (permissionStatus === 'granted' && !isRegistered) {
        await registerToken();
      }
    };

    // Small delay to ensure Capacitor is fully ready
    const timer = setTimeout(initNotifications, 1000);
    return () => clearTimeout(timer);
  }, [isNative, isSupported, permissionStatus, isRegistered, requestPermission, registerToken]);

  return null;
}
