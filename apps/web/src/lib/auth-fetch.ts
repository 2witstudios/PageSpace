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

  async fetch(url: string, options?: FetchOptions): Promise<Response> {
    const { skipAuth = false, maxRetries = 1, ...fetchOptions } = options || {};

    // For non-auth requests, just pass through
    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    // Make the initial request
    let response = await fetch(url, {
      ...fetchOptions,
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
        // Retry the original request
        response = await fetch(url, {
          ...fetchOptions,
          credentials: 'include',
        });
      } else {
        this.logger.error('Token refresh failed, returning 401 response', { url });
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
        // Retry all queued requests
        queue.forEach(async ({ resolve, reject, url, options }) => {
          try {
            const response = await fetch(url, {
              ...options,
              credentials: 'include',
            });
            resolve(response);
          } catch (error) {
            reject(error as Error);
          }
        });
      } else {
        // Reject all queued requests
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
  async delete<T = unknown>(url: string, options?: FetchOptions): Promise<T> {
    return this.fetchJSON<T>(url, {
      ...options,
      method: 'DELETE',
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

// Create a singleton instance
const authFetch = new AuthFetch();

// Export both the instance and the class for flexibility
export { authFetch, AuthFetch };

// Export convenience methods
export const fetchWithAuth = authFetch.fetch.bind(authFetch);
export const fetchJSON = authFetch.fetchJSON.bind(authFetch);
export const post = authFetch.post.bind(authFetch);
export const put = authFetch.put.bind(authFetch);
export const del = authFetch.delete.bind(authFetch);
export const patch = authFetch.patch.bind(authFetch);