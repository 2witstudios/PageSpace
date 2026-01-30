import type { PlatformStorage, StoredSession } from './types';
import { createId } from '@paralleldrive/cuid2';

export class WebStorage implements PlatformStorage {
  readonly platform = 'web' as const;

  async getSessionToken(): Promise<string | null> {
    return null; // Web uses cookies via credentials: 'include'
  }

  async getStoredSession(): Promise<StoredSession | null> {
    const deviceToken = localStorage.getItem('deviceToken');
    // Return session if deviceToken exists - deviceId is optional for web
    if (!deviceToken) return null;
    // Use browser_device_id key to match existing device-fingerprint.ts storage
    const deviceId =
      localStorage.getItem('browser_device_id') || localStorage.getItem('deviceId') || '';
    return { sessionToken: '', csrfToken: null, deviceId, deviceToken };
  }

  async storeSession(session: StoredSession): Promise<void> {
    if (session.deviceToken) localStorage.setItem('deviceToken', session.deviceToken);
    if (session.deviceId) localStorage.setItem('browser_device_id', session.deviceId);
  }

  async clearSession(): Promise<void> {
    localStorage.removeItem('deviceToken');
  }

  async getDeviceId(): Promise<string> {
    // Check both keys for backwards compatibility
    let id = localStorage.getItem('browser_device_id') || localStorage.getItem('deviceId');
    if (!id) {
      // Use CUID2 for consistency across codebase
      id = createId();
      localStorage.setItem('browser_device_id', id);
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
