import { createClientLogger } from '@/lib/logging/client-logger';

const logger = createClientLogger({ namespace: 'auth', component: 'token-csrf' });

const CSRF_EXEMPT_PATHS = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/google',
  '/api/auth/resend-verification',
  '/api/stripe/webhook',
  '/api/internal/',
];

const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function requiresCSRFToken(url: string, method: string = 'GET'): boolean {
  if (!MUTATION_METHODS.includes(method.toUpperCase())) {
    return false;
  }
  return !CSRF_EXEMPT_PATHS.some((path) => url.includes(path));
}

export interface CSRFTokenManager {
  getToken: (refresh?: boolean) => Promise<string | null>;
  setToken: (token: string | null) => void;
  clearToken: () => void;
}

export function createCSRFTokenManager(): CSRFTokenManager {
  let csrfToken: string | null = null;
  let csrfTokenPromise: Promise<string | null> | null = null;

  async function fetchCSRFToken(): Promise<string | null> {
    try {
      const response = await fetch('/api/auth/csrf', {
        credentials: 'include',
      });

      if (!response.ok) {
        logger.error('Failed to fetch CSRF token', {
          status: response.status,
        });
        return null;
      }

      const data = await response.json();
      logger.debug('CSRF token fetched successfully');
      return data.csrfToken;
    } catch (error) {
      logger.error('Error fetching CSRF token', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function getToken(refresh = false): Promise<string | null> {
    if (csrfToken && !refresh) {
      return csrfToken;
    }

    if (csrfTokenPromise) {
      return csrfTokenPromise;
    }

    csrfTokenPromise = fetchCSRFToken();

    try {
      const token = await csrfTokenPromise;
      csrfToken = token;
      return token;
    } finally {
      csrfTokenPromise = null;
    }
  }

  function clearToken(): void {
    csrfToken = null;
    csrfTokenPromise = null;
  }

  function setToken(token: string | null): void {
    csrfToken = token;
    csrfTokenPromise = null;
  }

  return { getToken, setToken, clearToken };
}
