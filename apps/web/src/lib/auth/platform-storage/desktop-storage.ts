import type { PlatformStorage, StoredSession } from './types';

export class DesktopStorage implements PlatformStorage {
  readonly platform = 'desktop' as const;

  async getSessionToken(): Promise<string | null> {
    return window.electron?.auth.getSessionToken() ?? null;
  }

  async getStoredSession(): Promise<StoredSession | null> {
    const session = await window.electron?.auth.getSession();
    if (!session) return null;
    const info = await window.electron?.auth.getDeviceInfo();
    return {
      sessionToken: session.sessionToken || '',
      csrfToken: session.csrfToken || null,
      deviceId: info?.deviceId || '',
      deviceToken: session.deviceToken || null,
    };
  }

  async storeSession(session: StoredSession): Promise<void> {
    await window.electron?.auth.storeSession({
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      deviceToken: session.deviceToken,
    });
  }

  async clearSession(): Promise<void> {
    await window.electron?.auth.clearAuth();
  }

  async getDeviceId(): Promise<string> {
    const info = await window.electron?.auth.getDeviceInfo();
    return info?.deviceId || '';
  }

  async getDeviceInfo() {
    const info = await window.electron?.auth.getDeviceInfo();
    return {
      deviceId: info?.deviceId || '',
      userAgent: info?.userAgent || navigator.userAgent,
      appVersion: info?.appVersion,
    };
  }

  usesBearer() {
    return true;
  }

  supportsCSRF() {
    return false;
  }

  dispatchAuthEvent(event: 'auth:cleared' | 'auth:refreshed' | 'auth:expired') {
    window.dispatchEvent(new CustomEvent(event));
  }
}
