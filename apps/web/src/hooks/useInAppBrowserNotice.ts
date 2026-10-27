'use client';

import { useEffect, useState } from 'react';
import { detectInAppBrowser } from '@/lib/auth/browser-detection';

interface InAppBrowserNotice {
  isInApp: boolean;
  appName: string | undefined;
}

const NOT_IN_APP: InAppBrowserNotice = { isInApp: false, appName: undefined };

/**
 * Should the sign-in / sign-up screen warn that Google's web OAuth is blocked
 * here and steer the user to a magic link?
 *
 * Resolved in an effect, never during render: the answer depends on
 * `navigator` and `window.Capacitor`, and the server has neither. The initial
 * state is therefore always "not in-app", which is also the right answer for
 * the Capacitor shell (see `detectInAppBrowser`).
 */
export function useInAppBrowserNotice(): InAppBrowserNotice {
  const [notice, setNotice] = useState<InAppBrowserNotice>(NOT_IN_APP);

  useEffect(() => {
    const result = detectInAppBrowser();
    if (result.isInApp) {
      setNotice({ isInApp: true, appName: result.appName });
    }
  }, []);

  return notice;
}
