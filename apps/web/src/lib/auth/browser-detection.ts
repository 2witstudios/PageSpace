import InAppSpy from 'inapp-spy';

export function detectInAppBrowser() {
  if (typeof navigator === 'undefined') return { isInApp: false, appName: undefined };
  return InAppSpy({ ua: navigator.userAgent });
}

export function getPreferredBrowserName(): 'Safari' | 'Chrome' | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'Safari';
  if (/android/i.test(ua)) return 'Chrome';
  return null;
}
