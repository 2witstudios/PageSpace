'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Hook to manage CSRF token for authenticated users.
 * Fetches CSRF token from /api/auth/csrf endpoint.
 */
export function useCSRFToken() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchToken = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/csrf', {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch CSRF token');
      }

      const data = await response.json();
      setCsrfToken(data.csrfToken);
    } catch (err) {
      console.error('Failed to fetch CSRF token:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch CSRF token');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchToken();
  }, [fetchToken]);

  const refreshToken = useCallback(async () => {
    await fetchToken();
  }, [fetchToken]);

  return {
    csrfToken,
    isLoading,
    error,
    refreshToken,
  };
}
