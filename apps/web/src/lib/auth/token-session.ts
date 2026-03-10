import { createClientLogger } from '@/lib/logging/client-logger';
import type { PlatformStorage } from './platform-storage';
import { SESSION_RETRY_DELAY_MS, TOKEN_RETRIEVAL_TIMEOUT_MS, type SessionCache } from './types';

const logger = createClientLogger({ namespace: 'auth', component: 'token-session' });

export interface SessionTokenManager {
  getTokenWithTimeout: (storage: PlatformStorage, url: string) => Promise<string | null>;
  getFromElectron: () => Promise<string | null>;
  clearCache: () => void;
  warmCache: (token: string) => void;
}

export function createSessionTokenManager(): SessionTokenManager {
  let sessionCache: SessionCache | null = null;
  let sessionFetchPromise: Promise<string | null> | null = null;

  async function getFromElectron(): Promise<string | null> {
    if (sessionCache) {
      return sessionCache.token;
    }

    const electron = window.electron;
    if (!electron) return null;

    if (sessionFetchPromise) {
      return sessionFetchPromise;
    }

    sessionFetchPromise = (async () => {
      try {
        let token = await electron.auth.getSessionToken();

        if (!token) {
          await new Promise(resolve => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
          token = await electron.auth.getSessionToken();

          if (token) {
            logger.info(`Session retrieval succeeded on retry after ${SESSION_RETRY_DELAY_MS}ms delay`);
          }
        }

        if (token) {
          sessionCache = { token };
        } else {
          logger.debug('Session token is null after IPC — not caching to allow future re-checks');
        }
        return token;
      } finally {
        sessionFetchPromise = null;
      }
    })();

    return sessionFetchPromise;
  }

  async function getTokenWithTimeout(storage: PlatformStorage, url: string): Promise<string | null> {
    if (sessionCache) {
      return sessionCache.token;
    }

    const tokenPromise = storage.platform === 'desktop'
      ? getFromElectron()
      : storage.getSessionToken();

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn(`${storage.platform}: Session token retrieval timed out after ${TOKEN_RETRIEVAL_TIMEOUT_MS}ms`, { url });
        resolve(null);
      }, TOKEN_RETRIEVAL_TIMEOUT_MS);
    });

    try {
      const token = await Promise.race([tokenPromise, timeoutPromise]);
      if (token) {
        sessionCache = { token };
      }
      return token;
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  function clearCache(): void {
    sessionCache = null;
  }

  function warmCache(token: string): void {
    sessionCache = { token };
  }

  return { getTokenWithTimeout, getFromElectron, clearCache, warmCache };
}
