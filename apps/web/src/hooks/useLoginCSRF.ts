'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Hook to manage login CSRF token for unauthenticated auth flows.
 * Used for passkey authentication, magic link, and other public auth endpoints.
 */
export function useLoginCSRF() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchToken = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login-csrf', {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch CSRF token');
      }

      const data = await response.json();
      setCsrfToken(data.csrfToken);
    } catch (err) {
      console.error('Failed to fetch login CSRF token:', err);
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
