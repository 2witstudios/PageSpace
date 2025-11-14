'use client';

import { createClientLogger } from '@/lib/logging/client-logger';

interface FetchOptions extends RequestInit {
  skipAuth?: boolean;
  maxRetries?: number;
}

interface QueuedRequest {
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
  url: string;
  options?: FetchOptions;
}

export interface SessionRefreshResult {
  success: boolean;
  shouldLogout: boolean;
}

class AuthFetch {
  private isRefreshing = false;
  private refreshQueue: QueuedRequest[] = [];
  private refreshPromise: Promise<SessionRefreshResult> | null = null;
  private logger = createClientLogger({ namespace: 'auth', component: 'auth-fetch' });
  private csrfToken: string | null = null;
  private csrfTokenPromise: Promise<string | null> | null = null;
  private jwtCache: { token: string | null; timestamp: number } | null = null;
  private readonly JWT_CACHE_TTL = 5000; // 5 seconds

  async fetch(url: string, options?: FetchOptions): Promise<Response> {
    const { skipAuth = false, maxRetries = 1, ...fetchOptions } = options || {};

    // For non-auth requests, just pass through
    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    // Detect Desktop environment
    const isDesktop = typeof window !== 'undefined' && 'electron' in window;

    // Prepare headers
    let headers = { ...fetchOptions.headers };

    if (isDesktop) {
      // Desktop: Use Bearer token authentication (CSRF-exempt)
      try {
        // Get JWT from Electron's secure storage (cached for performance)
        const jwt = await this.getJWTFromElectron();
        if (jwt) {
          headers = {
            ...headers,
            'Authorization': `Bearer ${jwt}`,
          };
          this.logger.debug('Desktop: Using Bearer token authentication', { url });
        } else {
          this.logger.warn('Desktop: No JWT available for Bearer token', { url });
        }
      } catch (error) {
        this.logger.error('Desktop: Failed to get JWT for Bearer token', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      // Web: Use cookie-based authentication with CSRF protection
      const needsCSRF = this.requiresCSRFToken(url, fetchOptions.method);
      if (needsCSRF) {
        const token = await this.getCSRFToken();
        if (token) {
          headers = {
            ...headers,
            'X-CSRF-Token': token,
          };
        }
      }
    }

    // Make the initial request
    // Note: Desktop uses 'include' to receive cookies on login, but sends them as Bearer token
    let response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'include', // Always include cookies (needed for login and fallback)
    });

    // If we get a 401 and haven't retried yet, try to refresh
    if (response.status === 401 && maxRetries > 0) {
      this.logger.warn('Received 401 response, attempting token refresh before retry', {
        url,
        retriesRemaining: maxRetries,
      });

      // If we're already refreshing, queue this request
      if (this.isRefreshing) {
        this.logger.debug('Token refresh already in progress, queuing request', {
          url,
          queuedRequests: this.refreshQueue.length + 1,
        });
        return this.queueRequest(url, { ...options, maxRetries: maxRetries - 1 });
      }

      // Start the refresh process
      const refreshSuccess = await this.refreshToken();

      if (refreshSuccess) {
        this.logger.info('Token refresh successful, retrying original request', { url });

        if (isDesktop) {
          // Desktop: Get fresh Bearer token (cache was already cleared in refreshToken())
          try {
            const freshJwt = await this.getJWTFromElectron();
            if (freshJwt) {
              headers = {
                ...headers,
                'Authorization': `Bearer ${freshJwt}`,
              };
              this.logger.debug('Desktop: Updated Bearer token after refresh', { url });
            } else {
              this.logger.warn('Desktop: No fresh JWT available after refresh', { url });
            }
          } catch (error) {
            this.logger.error('Desktop: Failed to get fresh JWT after refresh', {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Web: Get fresh CSRF token if needed
          const needsCSRF = this.requiresCSRFToken(url, fetchOptions.method);
          if (needsCSRF) {
            const token = await this.getCSRFToken(true);
            if (token) {
              headers = {
                ...headers,
                'X-CSRF-Token': token,
              };
            }
          }
        }

        // Retry the original request with fresh credentials
        response = await fetch(url, {
          ...fetchOptions,
          headers,
          credentials: 'include',
        });
      } else {
        this.logger.error('Token refresh failed, returning 401 response', { url });
      }
    }

    // Handle CSRF token errors (403) - refresh CSRF token and retry once (Web only)
    const needsCSRF = !isDesktop && this.requiresCSRFToken(url, fetchOptions.method);
    if (response.status === 403 && needsCSRF && maxRetries > 0) {
      const errorBody = await response.clone().json().catch(() => ({}));

      if (errorBody.code === 'CSRF_TOKEN_INVALID' || errorBody.code === 'CSRF_TOKEN_MISSING') {
        this.logger.warn('CSRF token invalid, refreshing and retrying', { url });

        // Refresh CSRF token
        const newToken = await this.getCSRFToken(true);
        if (newToken) {
          headers = {
            ...headers,
            'X-CSRF-Token': newToken,
          };

          // Retry with new CSRF token
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

  private async queueRequest(url: string, options?: FetchOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
      this.refreshQueue.push({ resolve, reject, url, options });
    });
  }

  private async refreshToken(): Promise<boolean> {
    // If we're already refreshing, wait for that to complete
    if (this.refreshPromise) {
      const result = await this.refreshPromise;
      return result.success;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const { success, shouldLogout } = await this.refreshPromise;

      // Process queued requests
      const queue = [...this.refreshQueue];
      this.refreshQueue = [];

      if (success) {
        // Clear JWT cache so all retries (original + queued) get fresh token
        // This must happen BEFORE retrying any requests
        this.clearJWTCache();
        this.logger.debug('JWT cache cleared after successful token refresh');

        // Retry all queued requests using this.fetch to preserve auth logic
        this.logger.info('Token refresh successful, retrying queued requests', {
          queuedRequests: queue.length,
        });

        queue.forEach(async ({ resolve, reject, url, options }) => {
          try {
            this.logger.debug('Retrying queued request after token refresh', { url });
            // Use this.fetch instead of plain fetch to preserve:
            // - CSRF token injection
            // - Proper headers
            // - Retry logic
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
        // Reject all queued requests
        this.logger.warn('Token refresh failed, rejecting queued requests', {
          queuedRequests: queue.length,
        });
        queue.forEach(({ reject }) => {
          reject(new Error('Authentication failed'));
        });
      }

      if (shouldLogout && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }

      return success;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<SessionRefreshResult> {
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;

    if (isDesktop) {
      return this.refreshDesktopSession();
    }

    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        // Optionally trigger auth state update
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('auth:refreshed'));
        }
        return { success: true, shouldLogout: false };
      }

      if (response.status === 401) {
        // Refresh token is invalid, trigger logout
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429 || response.status >= 500) {
        // Rate limiting or server errors - don't logout, just fail silently
        this.logger.warn('Token refresh request returned retryable status', {
          status: response.status,
        });
        return { success: false, shouldLogout: false };
      }

      // For other client errors, don't logout
      this.logger.error('Token refresh request failed with non-retryable status', {
        status: response.status,
      });
      return { success: false, shouldLogout: false };
    } catch (error) {
      this.logger.error('Token refresh request threw an error', {
        error: error instanceof Error ? error : String(error),
      });
      return { success: false, shouldLogout: false };
    }
  }

  private async refreshDesktopSession(): Promise<SessionRefreshResult> {
    if (!window.electron) {
      return { success: false, shouldLogout: false };
    }

    try {
      const session = await window.electron.auth.getSession();
      const deviceInfo = await window.electron.auth.getDeviceInfo();

      const refreshToken = session?.refreshToken;
      const deviceToken = session?.deviceToken ?? undefined;

      let response: Response | null = null;
      let shouldLogout = false;

      if (refreshToken) {
        const refreshPayload: {
          refreshToken: string;
          deviceId: string;
          platform: 'desktop';
          deviceToken?: string;
        } = {
          refreshToken,
          deviceId: deviceInfo.deviceId,
          platform: 'desktop',
        };

        if (deviceToken) {
          refreshPayload.deviceToken = deviceToken;
        }

        response = await fetch('/api/auth/mobile/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(refreshPayload),
        });

        if (response.ok) {
          this.logger.debug('Desktop: Refresh token exchange succeeded');
        }
      }

      if (!response || response.status === 401) {
        if (!deviceToken) {
          this.logger.warn('Desktop: Cannot refresh session - no device token available');
          return { success: false, shouldLogout: true };
        }

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

        if (response.status === 401) {
          shouldLogout = true;
        }
      } else if (response?.status === 401) {
        shouldLogout = !deviceToken;
      }

      if (!response || !response.ok) {
        this.logger.error('Desktop: Token refresh request failed', {
          status: response?.status,
        });
        return { success: false, shouldLogout };
      }

      const data = await response.json();

      await window.electron.auth.storeSession({
        accessToken: data.token,
        refreshToken: data.refreshToken,
        csrfToken: data.csrfToken,
        deviceToken: data.deviceToken,
      });

      this.clearJWTCache();
      this.logger.info('Desktop: Session refreshed successfully via secure storage');
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('auth:refreshed'));
      }
      return { success: true, shouldLogout: false };
    } catch (error) {
      this.logger.error('Desktop: Token refresh request threw an error', {
        error: error instanceof Error ? error : String(error),
      });
      return { success: false, shouldLogout: false };
    }
  }

  async refreshAuthSession(): Promise<SessionRefreshResult> {
    return this.doRefresh();
  }

  /**
   * Gets CSRF token, fetching it from the server if not cached
   * @param refresh - Force refresh the token even if cached
   */
  private async getCSRFToken(refresh = false): Promise<string | null> {
    // Return cached token if available and not forcing refresh
    if (this.csrfToken && !refresh) {
      return this.csrfToken;
    }

    // If a fetch is already in progress, wait for it
    if (this.csrfTokenPromise) {
      return this.csrfTokenPromise;
    }

    // Fetch CSRF token from server
    this.csrfTokenPromise = this.fetchCSRFToken();

    try {
      const token = await this.csrfTokenPromise;
      this.csrfToken = token;
      return token;
    } finally {
      this.csrfTokenPromise = null;
    }
  }

  /**
   * Fetches a new CSRF token from the server
   */
  private async fetchCSRFToken(): Promise<string | null> {
    try {
      const response = await fetch('/api/auth/csrf', {
        credentials: 'include',
      });

      if (!response.ok) {
        this.logger.error('Failed to fetch CSRF token', {
          status: response.status,
        });
        return null;
      }

      const data = await response.json();
      this.logger.debug('CSRF token fetched successfully');
      return data.csrfToken;
    } catch (error) {
      this.logger.error('Error fetching CSRF token', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Gets JWT token from Electron with caching to avoid excessive IPC calls.
   * Cache is valid for 5 seconds to balance performance and freshness.
   * @returns JWT string or null if not authenticated
   */
  private async getJWTFromElectron(): Promise<string | null> {
    const now = Date.now();

    // Return cached token if still valid
    if (this.jwtCache && (now - this.jwtCache.timestamp) < this.JWT_CACHE_TTL) {
      return this.jwtCache.token;
    }

    // Fetch fresh token from Electron
    const token = window.electron ? await window.electron.auth.getJWT() : null;
    this.jwtCache = { token, timestamp: now };
    return token;
  }

  /**
   * Clears the cached JWT token.
   * Should be called when user logs out or when token needs to be refreshed.
   */
  clearJWTCache(): void {
    this.jwtCache = null;
  }

  /**
   * Checks if a request requires CSRF token
   * CSRF is required for:
   * - Mutation methods (POST, PUT, PATCH, DELETE)
   * - API routes (not auth endpoints like login/signup)
   */
  private requiresCSRFToken(url: string, method: string = 'GET'): boolean {
    const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!mutationMethods.includes(method.toUpperCase())) {
      return false;
    }

    // Exempt certain auth endpoints that establish sessions
    const csrfExemptPaths = [
      '/api/auth/login',
      '/api/auth/signup',
      '/api/auth/refresh',
      '/api/auth/google',
      '/api/auth/resend-verification',
      '/api/stripe/webhook',
      '/api/internal/',
    ];

    return !csrfExemptPaths.some((path) => url.includes(path));
  }

  /**
   * Clears the cached CSRF token
   * Useful when logging out or when token needs to be refreshed
   */
  clearCSRFToken(): void {
    this.csrfToken = null;
    this.csrfTokenPromise = null;
  }

  // Helper method for JSON requests
  async fetchJSON<T = unknown>(url: string, options?: FetchOptions): Promise<T> {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Request failed');
      throw new Error(error);
    }

    return response.json();
  }

  // Helper method for POST requests
  async post<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Helper method for PUT requests
  async put<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Helper method for DELETE requests
  async delete<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Helper method for PATCH requests
  async patch<T = unknown>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

// Create a singleton instance (internal use only for binding)
const authFetch = new AuthFetch();

// Export the class for extensibility if needed
export { AuthFetch };

// Export convenience functions (preferred API)
export const fetchWithAuth = authFetch.fetch.bind(authFetch);
export const fetchJSON = authFetch.fetchJSON.bind(authFetch);
export const post = authFetch.post.bind(authFetch);
export const put = authFetch.put.bind(authFetch);
export const del = authFetch.delete.bind(authFetch);
export const patch = authFetch.patch.bind(authFetch);
export const clearCSRFToken = authFetch.clearCSRFToken.bind(authFetch);
export const clearJWTCache = authFetch.clearJWTCache.bind(authFetch);
export const refreshAuthSession = authFetch.refreshAuthSession.bind(authFetch);
