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

        const data = await response.json();
        setCsrfToken(data.csrfToken);
        return data.csrfToken as string;
      } catch (err) {
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
