import type { PlatformStorage, StoredSession } from './types';

export class IOSStorage implements PlatformStorage {
  readonly platform = 'ios' as const;

  async getSessionToken(): Promise<string | null> {
    const { getSessionToken } = await import('@/lib/ios-google-auth');
    return getSessionToken();
  }

  async getStoredSession(): Promise<StoredSession | null> {
    const { getStoredSession } = await import('@/lib/ios-google-auth');
    const session = await getStoredSession();
    if (!session) return null;
    return {
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken ?? null,
      deviceId: session.deviceId,
      deviceToken: session.deviceToken ?? null,
    };
  }

  async storeSession(session: StoredSession): Promise<void> {
    const { PageSpaceKeychain } = await import('@/lib/keychain-plugin');
    await PageSpaceKeychain.set({
      key: 'pagespace_session',
      value: JSON.stringify(session),
    });
  }

  async clearSession(): Promise<void> {
    const { clearStoredSession } = await import('@/lib/ios-google-auth');
    await clearStoredSession();
    this.dispatchAuthEvent('auth:cleared');
  }

  async getDeviceId(): Promise<string> {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: 'pagespace_device_id' });
    if (value) return value;
    const id = crypto.randomUUID();
    await Preferences.set({ key: 'pagespace_device_id', value: id });
    return id;
  }

  async getDeviceInfo() {
    return { deviceId: await this.getDeviceId(), userAgent: navigator.userAgent };
  }

  usesBearer() {
    return true;
  }

  supportsCSRF() {
    return false;
  }

  dispatchAuthEvent(event: 'auth:cleared' | 'auth:refreshed' | 'auth:expired') {
    window.dispatchEvent(new CustomEvent(event));
    console.log(`[iOS] Dispatched ${event}`);
  }
}
