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
  private sessionCache: { token: string | null; timestamp: number } | null = null;
  // Desktop session cache TTL reduced from 30s to 5s to minimize staleness risk
  // This is critical for desktop where token rotation after refresh was causing
  // stale token usage when the cache held old tokens
  private readonly SESSION_CACHE_TTL = 5000; // 5 seconds - prioritize freshness over IPC overhead
  private readonly SESSION_RETRY_DELAY_MS = 100; // 100ms retry delay for async storage
  private authClearedCleanup: (() => void) | null = null;
  private initialized = false;

  // Power state tracking for desktop (prevents refresh during sleep)
  private isSuspended = false;
  private suspendTime: number | null = null;
  private powerEventCleanups: (() => void)[] = [];

  // Refresh cooldown tracking - prevents rapid re-refresh after successful refresh
  // This handles the case where delayed callbacks (e.g., socket's 2-second timeout)
  // try to refresh after the main refresh already completed and rotated the device token
  private lastSuccessfulRefresh: number | null = null;
  private readonly REFRESH_COOLDOWN_MS = 5000; // 5 seconds cooldown after successful refresh

  constructor() {
    this.initializeListeners();
  }

  private initializeListeners(): void {
    // Prevent duplicate initialization (HMR, multiple imports)
    if (this.initialized) return;
    this.initialized = true;

    // Listen for desktop logout event to clear cache
    if (typeof window !== 'undefined' && window.electron) {
      // Clean up any existing listener first
      if (this.authClearedCleanup) {
        this.authClearedCleanup();
        this.authClearedCleanup = null;
      }

      const cleanup = window.electron.on?.('auth:cleared', () => {
        this.logger.info('Desktop auth cleared event received, clearing session cache');
        this.clearSessionCache();
        this.csrfToken = null;
      });

      if (cleanup) {
        this.authClearedCleanup = cleanup;
      }

      // Initialize power state listeners for desktop
      this.initializePowerListeners();
    }
  }

  /**
   * Initialize power state listeners for desktop app
   * This prevents auth refresh attempts during sleep and forces refresh on wake
   */
  private initializePowerListeners(): void {
    if (typeof window === 'undefined' || !window.electron?.power) return;

    // Clean up any existing listeners
    this.powerEventCleanups.forEach(cleanup => cleanup());
    this.powerEventCleanups = [];

    // Handle system suspend (sleep/hibernate)
    const suspendCleanup = window.electron.power.onSuspend(({ suspendTime }) => {
      this.isSuspended = true;
      this.suspendTime = suspendTime;
      this.logger.info('[Power] System suspended - pausing auth operations', { suspendTime });

      // Dispatch event for other components (like useTokenRefresh) to pause
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('power:suspend', { detail: { suspendTime } }));
      }
    });
    this.powerEventCleanups.push(suspendCleanup);

    // Handle system resume (wake from sleep)
    const resumeCleanup = window.electron.power.onResume(({ resumeTime, sleepDuration, forceRefresh }) => {
      this.isSuspended = false;
      const suspendedAt = this.suspendTime;
      this.suspendTime = null;

      this.logger.info('[Power] System resumed - resuming auth operations', {
        resumeTime,
        sleepDuration,
        sleepDurationMin: Math.round(sleepDuration / 60000),
        forceRefresh,
      });

      // Clear session cache on wake to ensure fresh token retrieval
      this.clearSessionCache();

      // Dispatch event for other components (like useTokenRefresh) to resume
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('power:resume', {
          detail: { resumeTime, sleepDuration, forceRefresh, suspendedAt }
        }));
      }
    });
    this.powerEventCleanups.push(resumeCleanup);

    // Handle screen unlock (user returned)
    const unlockCleanup = window.electron.power.onUnlockScreen(({ shouldRefresh }) => {
      this.logger.debug('[Power] Screen unlocked', { shouldRefresh });

      if (shouldRefresh) {
        // Clear session cache to ensure fresh auth state
        this.clearSessionCache();

        // Dispatch event for soft refresh
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('power:unlock', { detail: { shouldRefresh } }));
        }
      }
    });
    this.powerEventCleanups.push(unlockCleanup);

    this.logger.info('[Power] Power state listeners initialized');
  }

  /**
   * Check if the system is currently suspended (desktop only)
   */
  isSystemSuspended(): boolean {
    return this.isSuspended;
  }

  /**
   * Get the time when system was suspended (desktop only)
   */
  getSuspendTime(): number | null {
    return this.suspendTime;
  }

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
        // Get session token from Electron's secure storage (cached for performance)
        const sessionToken = await this.getSessionFromElectron();
        if (sessionToken) {
          headers = {
            ...headers,
            'Authorization': `Bearer ${sessionToken}`,
          };
          this.logger.debug('Desktop: Using Bearer token authentication', { url });
        } else {
          this.logger.warn('Desktop: No session token available for Bearer token', { url });
        }
      } catch (error) {
        this.logger.error('Desktop: Failed to get session token for Bearer token', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      // Web: Use cookie-based authentication with CSRF protection
      // Include device token for device tracking and "Revoke All Others" functionality
      const deviceToken = typeof localStorage !== 'undefined' ? localStorage.getItem('deviceToken') : null;
      if (deviceToken) {
        headers = {
          ...headers,
          'X-Device-Token': deviceToken,
        };
        this.logger.debug('Web: Using device token for authentication', { url });
      }

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
            const freshSession = await this.getSessionFromElectron();
            if (freshSession) {
              headers = {
                ...headers,
                'Authorization': `Bearer ${freshSession}`,
              };
              this.logger.debug('Desktop: Updated Bearer token after refresh', { url });
            } else {
              this.logger.warn('Desktop: No fresh session token available after refresh', { url });
            }
          } catch (error) {
            this.logger.error('Desktop: Failed to get fresh session token after refresh', {
              url,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Web: Re-add device token and get fresh CSRF token if needed
          const deviceToken = typeof localStorage !== 'undefined' ? localStorage.getItem('deviceToken') : null;
          if (deviceToken) {
            headers = {
              ...headers,
              'X-Device-Token': deviceToken,
            };
          }

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
    // Atomic check-and-set to prevent race condition where multiple threads
    // check null simultaneously before either sets the promise
    if (this.refreshPromise) {
      this.logger.debug('Refresh already in progress, joining queue');
      const result = await this.refreshPromise;
      return result.success;
    }

    // CRITICAL FIX: Clear session cache IMMEDIATELY before refresh starts
    // This prevents the race condition where:
    // 1. doRefresh() completes and stores new session
    // 2. Original request retries with getSessionFromElectron()
    // 3. Cache still contains OLD session token (5s TTL)
    // 4. Retry uses stale token → 401 → infinite loop
    // By clearing cache here, retry will read fresh session from storage
    this.clearSessionCache();
    this.logger.debug('Session cache cleared BEFORE token refresh to prevent stale retry');

    // Set flags and promise IMMEDIATELY (atomic operation)
    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const { success, shouldLogout } = await this.refreshPromise;

      // Process queued requests
      const queue = [...this.refreshQueue];
      this.refreshQueue = [];

      if (success) {
        // Track successful refresh for cooldown (prevents delayed callbacks from re-refreshing)
        this.lastSuccessfulRefresh = Date.now();

        // Defensive: Clear session cache again for queued requests
        // (Already cleared before doRefresh, but clear again in case queue accumulated during refresh)
        this.clearSessionCache();
        this.logger.debug('Session cache cleared after successful token refresh (for queued requests)');

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

    // Web: Session-based auth with sliding window expiry
    // Sessions are extended automatically by middleware on each authenticated request.
    // When a session expires (user inactive for 7 days), we attempt device token recovery.
    // If no device token exists, user must re-authenticate.
    try {
      const deviceToken = typeof localStorage !== 'undefined'
        ? localStorage.getItem('deviceToken')
        : null;

      if (!deviceToken) {
        // If we reached this point (doRefresh called), it means:
        // 1. A request returned 401 (session invalid/expired)
        // 2. We're trying to recover the session
        //
        // Without a device token, we CANNOT recover the session.
        // This happens when:
        // - Legacy user (logged in before device tokens for web)
        // - User cleared localStorage (lost device token)
        // - Device token generation failed on login
        //
        // CRITICAL: Return shouldLogout: true to prevent broken auth state.
        // Old logic (shouldLogout: false) caused Bug P2 where users appeared
        // logged in but all API calls failed. Clean logout provides better UX.
        this.logger.warn('Web: No device token - session expired, must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      // Try device token recovery
      this.logger.debug('Web: Attempting session recovery via device token');
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
        // Device token refresh succeeded - new session created
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
            this.logger.warn('Failed to persist refreshed device token', {
              error: storageError instanceof Error ? storageError.message : String(storageError),
            });
          }
        }

        if (refreshData?.csrfToken) {
          this.csrfToken = refreshData.csrfToken;
        } else {
          this.clearCSRFToken();
        }

        this.logger.info('Web: Session recovered via device token');
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('auth:refreshed'));
        }
        return { success: true, shouldLogout: false };
      }

      if (response.status === 401) {
        // Device token invalid - must re-authenticate
        this.logger.warn('Web: Device token invalid - logging out');
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429 || response.status >= 500) {
        // Rate limited or server error - don't logout, let retry handle it
        this.logger.warn('Web: Device refresh returned retryable status', { status: response.status });
        return { success: false, shouldLogout: false };
      }

      // Other client errors
      this.logger.error('Web: Device refresh failed', { status: response.status });
      return { success: false, shouldLogout: false };
    } catch (error) {
      this.logger.error('Web: Session refresh error', { error });
      return { success: false, shouldLogout: false };
    }
  }

  private async refreshDesktopSession(): Promise<SessionRefreshResult> {
    if (!window.electron) {
      return { success: false, shouldLogout: false };
    }

    // Don't attempt refresh if system is suspended - it will likely fail
    // and could incorrectly trigger logout
    if (this.isSuspended) {
      this.logger.warn('Desktop: Skipping refresh while system is suspended');
      return { success: false, shouldLogout: false };
    }

    try {
      const session = await window.electron.auth.getSession();
      const deviceInfo = await window.electron.auth.getDeviceInfo();

      const deviceToken = session?.deviceToken;

      // Desktop REQUIRES a device token for long-lived sessions
      // If no device token exists, user needs to re-authenticate
      if (!deviceToken) {
        this.logger.warn('Desktop: No device token found - user must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      let response: Response;

      // Device token refresh (90-day validity)
      // This is the PRIMARY auth mechanism for desktop - designed for long-lived sessions
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
          this.logger.debug('Desktop: Device token refresh succeeded');
        }
      } catch (networkError) {
        // Network error - don't logout, let retry logic handle it
        this.logger.warn('Desktop: Device token refresh network error', {
          error: networkError instanceof Error ? networkError.message : String(networkError),
        });
        return { success: false, shouldLogout: false };
      }

      if (response.status === 401) {
        // 401 = device token is genuinely invalid (expired or revoked)
        // User must re-authenticate
        this.logger.warn('Desktop: Device token rejected - user must re-authenticate');
        return { success: false, shouldLogout: true };
      }

      if (response.status === 429) {
        // Rate limited - don't logout, let retry logic handle it
        this.logger.warn('Desktop: Token refresh rate limited');
        return { success: false, shouldLogout: false };
      }

      if (response.status >= 500) {
        // Server error - don't logout, let retry logic handle it
        this.logger.warn('Desktop: Token refresh server error', { status: response.status });
        return { success: false, shouldLogout: false };
      }

      if (!response.ok) {
        this.logger.error('Desktop: Token refresh failed with unexpected status', {
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

      this.clearSessionCache();
      this.logger.info('Desktop: Session refreshed successfully via secure storage');
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('auth:refreshed'));
      }
      return { success: true, shouldLogout: false };
    } catch (error) {
      this.logger.error('Desktop: Token refresh request threw an error', {
        error: error instanceof Error ? error : String(error),
      });
      // Don't logout on unexpected errors - let retry logic handle it
      return { success: false, shouldLogout: false };
    }
  }

  async refreshAuthSession(): Promise<SessionRefreshResult> {
    // CRITICAL FIX: Use the same deduplication as refreshToken() to prevent race conditions
    // Previously this called doRefresh() directly, allowing concurrent refreshes when:
    // 1. auth-fetch's internal refreshToken() is triggered by 401
    // 2. useTokenRefresh's scheduled refresh calls refreshAuthSession()
    // Both would call doRefresh() independently, and if device token was rotated by the first,
    // the second would fail with 401 → shouldLogout: true → user logged out!
    if (this.refreshPromise) {
      this.logger.debug('Refresh already in progress via refreshAuthSession, joining existing promise');
      return this.refreshPromise;
    }

    // COOLDOWN CHECK: If we just successfully refreshed, skip this attempt
    // This prevents delayed callbacks (e.g., socket's 2-second timeout) from triggering
    // a redundant refresh after the main refresh already completed and rotated the device token
    if (this.lastSuccessfulRefresh && (Date.now() - this.lastSuccessfulRefresh) < this.REFRESH_COOLDOWN_MS) {
      this.logger.debug('Skipping refresh - within cooldown period after recent successful refresh', {
        timeSinceLastRefresh: Date.now() - this.lastSuccessfulRefresh,
        cooldownMs: this.REFRESH_COOLDOWN_MS,
      });
      return { success: true, shouldLogout: false };
    }

    // Clear session cache before refresh to prevent stale token usage
    this.clearSessionCache();

    // Set the shared promise
    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const result = await this.refreshPromise;

      // Process queued requests (mirroring refreshToken() behavior)
      const queue = [...this.refreshQueue];
      this.refreshQueue = [];

      if (result.success) {
        // Track successful refresh for cooldown
        this.lastSuccessfulRefresh = Date.now();

        // Clear session cache for queued requests to get fresh token
        this.clearSessionCache();

        // Retry all queued requests
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
        // Reject all queued requests
        this.logger.warn('refreshAuthSession: Rejecting queued requests', {
          queuedRequests: queue.length,
        });
        queue.forEach(({ reject }) => {
          reject(new Error('Authentication failed'));
        });
      }

      if (result.shouldLogout && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }

      return result;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
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
   * Gets session token from Electron with caching to avoid excessive IPC calls.
   * Cache is valid for 5 seconds to balance performance and freshness.
   * @returns Session token string or null if not authenticated
   */
  private async getSessionFromElectron(): Promise<string | null> {
    const now = Date.now();

    // Return cached token if still valid
    if (this.sessionCache && (now - this.sessionCache.timestamp) < this.SESSION_CACHE_TTL) {
      return this.sessionCache.token;
    }

    if (!window.electron) return null;

    // Fetch fresh token from Electron
    let token = await window.electron.auth.getSessionToken();

    // DEFENSIVE FIX: If null, retry once after brief delay
    // This handles async timing issues where storage hasn't completed yet
    if (!token) {
      await new Promise(resolve => setTimeout(resolve, this.SESSION_RETRY_DELAY_MS));
      token = await window.electron.auth.getSessionToken();

      if (token) {
        this.logger.info(`Session retrieval succeeded on retry after ${this.SESSION_RETRY_DELAY_MS}ms delay`);
      }
    }

    this.sessionCache = { token, timestamp: now };
    return token;
  }

  /**
   * Clears the cached session token.
   * Should be called when user logs out or when token needs to be refreshed.
   */
  clearSessionCache(): void {
    this.sessionCache = null;
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
      // REMOVED: '/api/auth/refresh' - route doesn't exist (dropped in device token migration)
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
      const text = await response.text().catch(() => 'Request failed');
      // Try to parse JSON error response and extract error message
      try {
        const json = JSON.parse(text);
        throw new Error(json.error || json.message || text);
      } catch (parseError) {
        // If parsing fails, it's not JSON - use the raw text
        if (parseError instanceof SyntaxError) {
          throw new Error(text);
        }
        // Re-throw if it's our Error from above
        throw parseError;
      }
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

// Create a true global singleton using Symbol.for to ensure single instance
// across different import paths and bundler contexts (critical for mobile apps)
const AUTHFETCH_KEY = Symbol.for('pagespace.authfetch.singleton');

function getAuthFetch(): AuthFetch {
  const globalObj = globalThis as typeof globalThis & { [key: symbol]: AuthFetch };
  if (!globalObj[AUTHFETCH_KEY]) {
    globalObj[AUTHFETCH_KEY] = new AuthFetch();
    console.log('[AUTH_FETCH] Created global singleton instance');
  }
  return globalObj[AUTHFETCH_KEY];
}

// Export the class for extensibility if needed
export { AuthFetch };

// Export convenience functions using guaranteed singleton
// This ensures all imports reference the same AuthFetch instance
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

export const refreshAuthSession = () =>
  getAuthFetch().refreshAuthSession();

export const isSystemSuspended = () =>
  getAuthFetch().isSystemSuspended();

export const getSuspendTime = () =>
  getAuthFetch().getSuspendTime();
