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

class AuthFetch {
  private isRefreshing = false;
  private refreshQueue: QueuedRequest[] = [];
  private refreshPromise: Promise<boolean> | null = null;
  private logger = createClientLogger({ namespace: 'auth', component: 'auth-fetch' });
  private csrfToken: string | null = null;
  private csrfTokenPromise: Promise<string | null> | null = null;

  async fetch(url: string, options?: FetchOptions): Promise<Response> {
    const { skipAuth = false, maxRetries = 1, ...fetchOptions } = options || {};

    // For non-auth requests, just pass through
    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    // Check if this request needs CSRF protection
    const needsCSRF = this.requiresCSRFToken(url, fetchOptions.method);

    // Get CSRF token if needed
    let headers = { ...fetchOptions.headers };
    if (needsCSRF) {
      const token = await this.getCSRFToken();
      if (token) {
        headers = {
          ...headers,
          'X-CSRF-Token': token,
        };
      }
    }

    // Make the initial request
    let response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'include', // Always include cookies
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

        // Get fresh CSRF token if needed
        if (needsCSRF) {
          const token = await this.getCSRFToken(true);
          if (token) {
            headers = {
              ...headers,
              'X-CSRF-Token': token,
            };
          }
        }

        // Retry the original request
        response = await fetch(url, {
          ...fetchOptions,
          headers,
          credentials: 'include',
        });
      } else {
        this.logger.error('Token refresh failed, returning 401 response', { url });
      }
    }

    // Handle CSRF token errors (403) - refresh CSRF token and retry once
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
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      const success = await this.refreshPromise;
      
      // Process queued requests
      const queue = [...this.refreshQueue];
      this.refreshQueue = [];

      if (success) {
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

      return success;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
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
        return true;
      }

      if (response.status === 401) {
        // Refresh token is invalid, trigger logout
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        return false;
      }

      if (response.status === 429 || response.status >= 500) {
        // Rate limiting or server errors - don't logout, just fail silently
        this.logger.warn('Token refresh request returned retryable status', {
          status: response.status,
        });
        return false;
      }

      // For other client errors, don't logout
      this.logger.error('Token refresh request failed with non-retryable status', {
        status: response.status,
      });
      return false;
    } catch (error) {
      this.logger.error('Token refresh request threw an error', {
        error: error instanceof Error ? error : String(error),
      });
      return false;
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