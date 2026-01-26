import type { PlatformStorage, StoredSession } from './types';

export class WebStorage implements PlatformStorage {
  readonly platform = 'web' as const;

  async getSessionToken(): Promise<string | null> {
    return null; // Web uses cookies via credentials: 'include'
  }

  async getStoredSession(): Promise<StoredSession | null> {
    const deviceToken = localStorage.getItem('deviceToken');
    const deviceId = localStorage.getItem('deviceId');
    if (!deviceId) return null;
    return { sessionToken: '', csrfToken: null, deviceId, deviceToken };
  }

  async storeSession(session: StoredSession): Promise<void> {
    if (session.deviceToken) localStorage.setItem('deviceToken', session.deviceToken);
    if (session.deviceId) localStorage.setItem('deviceId', session.deviceId);
  }

  async clearSession(): Promise<void> {
    localStorage.removeItem('deviceToken');
  }

  async getDeviceId(): Promise<string> {
    let id = localStorage.getItem('deviceId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('deviceId', id);
    }
    return id;
  }

  async getDeviceInfo() {
    return { deviceId: await this.getDeviceId(), userAgent: navigator.userAgent };
  }

  usesBearer() {
    return false;
  }

  supportsCSRF() {
    return true;
  }
}
