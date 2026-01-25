'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { isElectron } from '@/lib/utils/utils';

/**
 * Redirects native app users (Capacitor iOS/Android, Electron desktop)
 * away from the landing page to /dashboard.
 *
 * The dashboard will handle auth checks and redirect to /signin if needed.
 */
export default function NativeAppRedirect() {
  const router = useRouter();

  useEffect(() => {
    const isNativeApp = isCapacitorApp() || isElectron();
    if (isNativeApp) {
      router.replace('/dashboard');
    }
  }, [router]);

  return null;
}
