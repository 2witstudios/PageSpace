import { createClientLogger } from '@/lib/logging/client-logger';
import type { PlatformStorage } from './platform-storage';
import type { SessionRefreshResult, PowerState } from './types';

const logger = createClientLogger({ namespace: 'auth', component: 'session-refresh' });

export type RefreshCallback = () => Promise<SessionRefreshResult>;

export interface SessionRefreshManager {
  refreshBearerSession: (storage: PlatformStorage) => Promise<SessionRefreshResult>;
  refreshWebSession: () => Promise<SessionRefreshResult>;
  refreshDesktopSession: (powerState: PowerState) => Promise<SessionRefreshResult>;
}

export function createSessionRefreshManager(
  onSessionCleared: () => void,
  onCSRFTokenSet: (token: string) => void,
  onCSRFTokenCleared: () => void
): SessionRefreshManager {
  async function refreshBearerSession(storage: PlatformStorage): Promise<SessionRefreshResult> {
    try {
      const session = await storage.getStoredSession();
      const info = await storage.getDeviceInfo();

      if (!session?.deviceToken || !info.deviceId) {
        logger.warn(`${storage.platform}: No device token - must re-authenticate`);
        return { success: false, shouldLogout: true };
      }

      const endpoint = storage.platform === 'ios'
        ? '/api/auth/mobile/refresh'
        : '/api/auth/device/refresh';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceToken: session.deviceToken,
          deviceId: info.deviceId,
          platform: storage.platform,
          userAgent: info.userAgent,
          appVersion: info.appVersion,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        await storage.storeSession({
          sessionToken: data.sessionToken,
          csrfToken: data.csrfToken || null,
          deviceId: info.deviceId,
          deviceToken: data.deviceToken || session.deviceToken,
        });
        onSessionCleared();
        storage.dispatchAuthEvent?.('auth:refreshed');
        logger.info(`${storage.platform}: Session refreshed successfully`);
        return { success: true, shouldLogout: false };
      }

      if (response.status === 401) {
        await storage.clearSession();
        logger.warn(`${storage.platform}: Device token invalid - logging out`);
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429 || response.status >= 500) {
        logger.warn(`${storage.platform}: Refresh returned retryable status`, { status: response.status });
        return { success: false, shouldLogout: false };
      }

      logger.error(`${storage.platform}: Refresh failed`, { status: response.status });
      return { success: false, shouldLogout: false };
    } catch (error) {
      logger.error(`${storage.platform}: Refresh error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, shouldLogout: false };
    }
  }

  async function refreshWebSession(): Promise<SessionRefreshResult> {
    try {
      const deviceToken = typeof localStorage !== 'undefined'
        ? localStorage.getItem('deviceToken')
        : null;

      if (!deviceToken) {
        logger.warn('Web: No device token - session expired, must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      logger.debug('Web: Attempting session recovery via device token');
      const { getOrCreateDeviceId } = await import('@/lib/analytics/device-fingerprint');
      const deviceId = getOrCreateDeviceId();

      const response = await fetch('/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceToken,
          deviceId,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        }),
      });

      if (response.ok) {
        let refreshData: { deviceToken?: string; csrfToken?: string } | null = null;
        try {
          refreshData = await response.json();
        } catch {
          refreshData = null;
        }

        if (refreshData?.deviceToken && typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem('deviceToken', refreshData.deviceToken);
          } catch (storageError) {
            logger.warn('Failed to persist refreshed device token', {
              error: storageError instanceof Error ? storageError.message : String(storageError),
            });
          }
        }

        if (refreshData?.csrfToken) {
          onCSRFTokenSet(refreshData.csrfToken);
        } else {
          onCSRFTokenCleared();
        }

        logger.info('Web: Session recovered via device token');
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('auth:refreshed'));
        }
        return { success: true, shouldLogout: false };
      }

      if (response.status === 401) {
        logger.warn('Web: Device token invalid - logging out');
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429 || response.status >= 500) {
        logger.warn('Web: Device refresh returned retryable status', { status: response.status });
        return { success: false, shouldLogout: false };
      }

      logger.error('Web: Device refresh failed', { status: response.status });
      return { success: false, shouldLogout: false };
    } catch (error) {
      logger.error('Web: Session refresh error', { error });
      return { success: false, shouldLogout: false };
    }
  }

  async function refreshDesktopSession(powerState: PowerState): Promise<SessionRefreshResult> {
    if (!window.electron) {
      return { success: false, shouldLogout: false };
    }

    if (powerState.isSuspended) {
      logger.warn('Desktop: Skipping refresh while system is suspended');
      return { success: false, shouldLogout: false };
    }

    try {
      const session = await window.electron.auth.getSession();
      const deviceInfo = await window.electron.auth.getDeviceInfo();

      const deviceToken = session?.deviceToken;

      if (!deviceToken) {
        logger.warn('Desktop: No device token found - user must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      let response: Response;

      try {
        response = await fetch('/api/auth/device/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceToken,
            deviceId: deviceInfo.deviceId,
            userAgent: deviceInfo.userAgent,
            appVersion: deviceInfo.appVersion,
          }),
        });

        if (response.ok) {
          logger.debug('Desktop: Device token refresh succeeded');
        }
      } catch (networkError) {
        logger.warn('Desktop: Device token refresh network error', {
          error: networkError instanceof Error ? networkError.message : String(networkError),
        });
        return { success: false, shouldLogout: false };
      }

      if (response.status === 401) {
        logger.warn('Desktop: Device token rejected - user must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429) {
        logger.warn('Desktop: Token refresh rate limited');
        return { success: false, shouldLogout: false };
      }

      if (response.status >= 500) {
        logger.warn('Desktop: Token refresh server error', { status: response.status });
        return { success: false, shouldLogout: false };
      }

      if (!response.ok) {
        logger.error('Desktop: Token refresh failed with unexpected status', {
          status: response.status,
        });
        return { success: false, shouldLogout: false };
      }

      const data = await response.json();

      await window.electron.auth.storeSession({
        sessionToken: data.sessionToken,
        csrfToken: data.csrfToken,
        deviceToken: data.deviceToken,
      });

      onSessionCleared();
      logger.info('Desktop: Session refreshed successfully via secure storage');
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('auth:refreshed'));
      }
      return { success: true, shouldLogout: false };
    } catch (error) {
      logger.error('Desktop: Token refresh request threw an error', {
        error: error instanceof Error ? error : String(error),
      });
      return { success: false, shouldLogout: false };
    }
  }

  return { refreshBearerSession, refreshWebSession, refreshDesktopSession };
}
