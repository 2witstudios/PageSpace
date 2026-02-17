'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Factory that creates a CSRF token hook for a given endpoint.
 */
export function createCSRFHook(endpoint: string) {
  return function useCSRF() {
    const [csrfToken, setCsrfToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchToken = useCallback(async (): Promise<string | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(endpoint, {
          credentials: 'include',
        });

        if (!response.ok) {
          throw new Error('Failed to fetch CSRF token');
        }

        const data: unknown = await response.json();
        const token =
          typeof data === 'object' && data !== null && 'csrfToken' in data
            ? (data as { csrfToken: unknown }).csrfToken
            : undefined;
        if (typeof token !== 'string' || !token) {
          throw new Error('Invalid CSRF token response');
        }
        setCsrfToken(token);
        return token;
      } catch (err) {
        setCsrfToken(null);
        console.error('Failed to fetch CSRF token:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch CSRF token');
        return null;
      } finally {
        setIsLoading(false);
      }
    }, []);

    useEffect(() => {
      fetchToken();
    }, [fetchToken]);

    const refreshToken = useCallback(async (): Promise<string | null> => {
      return fetchToken();
    }, [fetchToken]);

    return {
      csrfToken,
      isLoading,
      error,
      refreshToken,
    };
  };
}
