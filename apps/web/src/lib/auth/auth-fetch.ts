'use client';

import { createClientLogger } from '@/lib/logging/client-logger';
import { getPlatformStorage, type PlatformStorage } from './platform-storage';
import { type FetchOptions, type SessionRefreshResult, REFRESH_COOLDOWN_MS } from './types';
import { createCSRFTokenManager, requiresCSRFToken } from './token-csrf';
import { createSessionTokenManager } from './token-session';
import { createSessionRefreshManager } from './session-refresh';
import { createLifecycleManager } from './lifecycle-events';
import { validateRequestUrl, createRequestQueue } from './request-utils';

export type { FetchOptions, SessionRefreshResult } from './types';

class AuthFetch {
  private isRefreshing = false;
  private refreshPromise: Promise<SessionRefreshResult> | null = null;
  private logger = createClientLogger({ namespace: 'auth', component: 'auth-fetch' });
  private storage: PlatformStorage | null = null;

  private lastSuccessfulRefresh: number | null = null;

  private csrfManager = createCSRFTokenManager();
  private sessionManager = createSessionTokenManager();
  private requestQueue = createRequestQueue();

  private lifecycleManager = createLifecycleManager();

  private refreshManager = createSessionRefreshManager(
    () => this.sessionManager.clearCache(),
    (token: string) => this.csrfManager.setToken(token),
    () => this.csrfManager.clearToken()
  );

  constructor() {
    this.initializeListeners();
  }

  private getStorage(): PlatformStorage {
    if (!this.storage) {
      this.storage = getPlatformStorage();
    }
    return this.storage;
  }

  private initializeListeners(): void {
    this.lifecycleManager.initialize(
      () => {
        this.sessionManager.clearCache();
        this.csrfManager.clearToken();
      },
      () => this.csrfManager.clearToken(),
      () => this.refreshAuthSession()
    );
  }

  isSystemSuspended(): boolean {
    return this.lifecycleManager.getPowerState().isSuspended;
  }

  getSuspendTime(): number | null {
    return this.lifecycleManager.getPowerState().suspendTime;
  }

  async fetch(url: string, options?: FetchOptions): Promise<Response> {
    const { skipAuth = false, maxRetries = 1, ...fetchOptions } = options || {};

    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    validateRequestUrl(url);

    const storage = this.getStorage();
    let headers = { ...fetchOptions.headers };

    if (storage.usesBearer()) {
      try {
        const sessionToken = await this.sessionManager.getTokenWithTimeout(storage, url);
        if (sessionToken) {
          headers = {
            ...headers,
            'Authorization': `Bearer ${sessionToken}`,
          };
          this.logger.debug(`${storage.platform}: Using Bearer token authentication`, { url });
        } else {
          this.logger.warn(`${storage.platform}: No session token available for Bearer token`, { url });
        }
      } catch (error) {
        this.logger.error(`${storage.platform}: Failed to get session token for Bearer token`, {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      const session = await storage.getStoredSession();
      if (session?.deviceToken) {
        headers = {
          ...headers,
          'X-Device-Token': session.deviceToken,
        };
        this.logger.debug('Web: Using device token for authentication', { url });
      }

      if (storage.supportsCSRF() && requiresCSRFToken(url, fetchOptions.method)) {
        const token = await this.csrfManager.getToken();
        if (token) {
          headers = {
            ...headers,
            'X-CSRF-Token': token,
          };
        }
      }
    }

    let response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'include',
    });

    if (response.status === 401 && maxRetries > 0) {
      this.logger.warn('Received 401 response, attempting token refresh before retry', {
        url,
        retriesRemaining: maxRetries,
      });

      if (this.isRefreshing) {
        this.logger.debug('Token refresh already in progress, queuing request', {
          url,
          queuedRequests: this.requestQueue.length + 1,
        });
        return this.requestQueue.enqueue(url, { ...options, maxRetries: maxRetries - 1 });
      }

      const refreshSuccess = await this.refreshToken();

      if (refreshSuccess) {
        this.logger.info('Token refresh successful, retrying original request', { url });

        if (storage.usesBearer()) {
          try {
            const freshSession = storage.platform === 'desktop'
              ? await this.sessionManager.getFromElectron()
              : await storage.getSessionToken();
            if (freshSession) {
              headers = {
                ...headers,
                'Authorization': `Bearer ${freshSession}`,
              };
              this.logger.debug(`${storage.platform}: Updated Bearer token after refresh`, { url });
            } else {
              this.logger.warn(`${storage.platform}: No fresh session token available after refresh`, { url });
            }
          } catch (error) {
            this.logger.error(`${storage.platform}: Failed to get fresh session token after refresh`, {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          const session = await storage.getStoredSession();
          if (session?.deviceToken) {
            headers = {
              ...headers,
              'X-Device-Token': session.deviceToken,
            };
          }

          if (storage.supportsCSRF() && requiresCSRFToken(url, fetchOptions.method)) {
            const token = await this.csrfManager.getToken(true);
            if (token) {
              headers = {
                ...headers,
                'X-CSRF-Token': token,
              };
            }
          }
        }

        response = await fetch(url, {
          ...fetchOptions,
          headers,
          credentials: 'include',
        });
      } else {
        this.logger.error('Token refresh failed, returning 401 response', { url });
      }
    }

    const needsCSRF = storage.supportsCSRF() && requiresCSRFToken(url, fetchOptions.method);
    if (response.status === 403 && needsCSRF && maxRetries > 0) {
      const errorBody = await response.clone().json().catch(() => ({}));

      if (errorBody.code === 'CSRF_TOKEN_INVALID' || errorBody.code === 'CSRF_TOKEN_MISSING') {
        this.logger.warn('CSRF token invalid, refreshing and retrying', { url });

        const newToken = await this.csrfManager.getToken(true);
        if (newToken) {
          headers = {
            ...headers,
            'X-CSRF-Token': newToken,
          };

          response = await fetch(url, {
            ...fetchOptions,
            headers,
            credentials: 'include',
          });
        }
      }
    }

    return response;
  }

  private async refreshToken(): Promise<boolean> {
    if (this.refreshPromise) {
      this.logger.debug('Refresh already in progress, joining queue');
      const result = await this.refreshPromise;
      return result.success;
    }

    this.sessionManager.clearCache();
    this.logger.debug('Session cache cleared BEFORE token refresh to prevent stale retry');

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const { success, shouldLogout } = await this.refreshPromise;

      const queue = this.requestQueue.dequeueAll();

      if (success) {
        this.lastSuccessfulRefresh = Date.now();

        this.sessionManager.clearCache();
        this.logger.debug('Session cache cleared after successful token refresh (for queued requests)');

        this.logger.info('Token refresh successful, retrying queued requests', {
          queuedRequests: queue.length,
        });

        queue.forEach(async ({ resolve, reject, url, options }) => {
          try {
            this.logger.debug('Retrying queued request after token refresh', { url });
            const response = await this.fetch(url, options);
            this.logger.debug('Queued request retry successful', {
              url,
              status: response.status,
            });
            resolve(response);
          } catch (error) {
            this.logger.error('Queued request retry failed', {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
            reject(error as Error);
          }
        });
      } else {
        this.logger.warn('Token refresh failed, rejecting queued requests', {
          queuedRequests: queue.length,
        });
        queue.forEach(({ reject }) => {
          reject(new Error('Authentication failed'));
        });
      }

      if (shouldLogout && typeof window !== 'undefined') {
        const { useAuthStore } = await import('@/stores/useAuthStore');
        if (useAuthStore.getState().isAuthenticated) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
      }

      return success;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<SessionRefreshResult> {
    const storage = this.getStorage();

    if (storage.usesBearer()) {
      if (storage.platform === 'desktop') {
        return this.refreshManager.refreshDesktopSession(this.lifecycleManager.getPowerState());
      }
      return this.refreshManager.refreshBearerSession(storage);
    }

    return this.refreshManager.refreshWebSession();
  }

  async refreshAuthSession(): Promise<SessionRefreshResult> {
    if (this.refreshPromise) {
      this.logger.debug('Refresh already in progress via refreshAuthSession, joining existing promise');
      return this.refreshPromise;
    }

    if (this.lastSuccessfulRefresh && (Date.now() - this.lastSuccessfulRefresh) < REFRESH_COOLDOWN_MS) {
      this.logger.debug('Skipping refresh - within cooldown period after recent successful refresh', {
        timeSinceLastRefresh: Date.now() - this.lastSuccessfulRefresh,
        cooldownMs: REFRESH_COOLDOWN_MS,
      });
      return { success: true, shouldLogout: false };
    }

    this.sessionManager.clearCache();

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const result = await this.refreshPromise;

      const queue = this.requestQueue.dequeueAll();

      if (result.success) {
        this.lastSuccessfulRefresh = Date.now();

        this.sessionManager.clearCache();

        this.logger.info('refreshAuthSession: Retrying queued requests', {
          queuedRequests: queue.length,
        });

        queue.forEach(async ({ resolve, reject, url, options }) => {
          try {
            this.logger.debug('Retrying queued request after refreshAuthSession', { url });
            const response = await this.fetch(url, options);
            this.logger.debug('Queued request retry successful', {
              url,
              status: response.status,
            });
            resolve(response);
          } catch (error) {
            this.logger.error('Queued request retry failed', {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
            reject(error as Error);
          }
        });
      } else {
        this.logger.warn('refreshAuthSession: Rejecting queued requests', {
          queuedRequests: queue.length,
        });
        queue.forEach(({ reject }) => {
          reject(new Error('Authentication failed'));
        });
      }

      if (result.shouldLogout && typeof window !== 'undefined') {
        const { useAuthStore } = await import('@/stores/useAuthStore');
        if (useAuthStore.getState().isAuthenticated) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
      }

      return result;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  clearSessionCache(): void {
    this.sessionManager.clearCache();
  }

  warmSessionCache(token: string): void {
    this.sessionManager.warmCache(token);
  }

  clearCSRFToken(): void {
    this.csrfManager.clearToken();
  }

  async fetchJSON<T = unknown>(url: string, options?: FetchOptions): Promise<T> {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Request failed');
      try {
        const json = JSON.parse(text);
        throw new Error(json.error || json.message || text);
      } catch (parseError) {
        if (parseError instanceof SyntaxError) {
          throw new Error(text);
        }
        throw parseError;
      }
    }

    return response.json();
  }

  async post<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async patch<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

const AUTHFETCH_KEY = Symbol.for('pagespace.authfetch.singleton');

function getAuthFetch(): AuthFetch {
  const globalObj = globalThis as typeof globalThis & { [key: symbol]: AuthFetch };
  if (!globalObj[AUTHFETCH_KEY]) {
    globalObj[AUTHFETCH_KEY] = new AuthFetch();
    console.log('[AUTH_FETCH] Created global singleton instance');
  }
  return globalObj[AUTHFETCH_KEY];
}

export { AuthFetch };

export const fetchWithAuth = (...args: Parameters<AuthFetch['fetch']>) =>
  getAuthFetch().fetch(...args);

export const fetchJSON = <T = unknown>(...args: Parameters<AuthFetch['fetchJSON']>) =>
  getAuthFetch().fetchJSON<T>(...args);

export const post = <T = unknown>(url: string, body?: unknown, options?: FetchOptions) =>
  getAuthFetch().post<T>(url, body, options);

export const put = <T = unknown>(url: string, body?: unknown, options?: FetchOptions) =>
  getAuthFetch().put<T>(url, body, options);

export const del = <T = unknown>(url: string, body?: unknown, options?: FetchOptions) =>
  getAuthFetch().delete<T>(url, body, options);

export const patch = <T = unknown>(url: string, body?: unknown, options?: FetchOptions) =>
  getAuthFetch().patch<T>(url, body, options);

export const clearCSRFToken = () =>
  getAuthFetch().clearCSRFToken();

export const clearSessionCache = () =>
  getAuthFetch().clearSessionCache();

export const warmSessionCache = (token: string) =>
  getAuthFetch().warmSessionCache(token);

export const refreshAuthSession = () =>
  getAuthFetch().refreshAuthSession();

export const isSystemSuspended = () =>
  getAuthFetch().isSystemSuspended();

export const getSuspendTime = () =>
  getAuthFetch().getSuspendTime();
