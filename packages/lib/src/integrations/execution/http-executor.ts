/**
 * HTTP Executor
 *
 * Executes HTTP requests with retry logic, timeout handling,
 * and proper error categorization.
 *
 * SSRF guard: every target URL — the initial one and every redirect hop — is
 * validated (scheme, blocked hosts, and DNS resolution with every address
 * required to be public) immediately before connecting, and the connection is
 * then PINNED to the validated address (`pinnedFetch`), so a DNS answer that
 * changes between validation and connect cannot redirect the request. The
 * validation itself is bounded by the request's abort signal. Redirects are
 * never followed by the client; the executor follows only same-origin hops,
 * so the connection's credential headers never travel to another origin.
 */

import {
  validateIntegrationTargetUrl,
  type IntegrationTargetDecision,
} from '../validation/validate-base-url';
import { pinnedFetch, type PinnedFetch } from './pinned-fetch';

type TargetValidator = (url: string, signal: AbortSignal) => Promise<IntegrationTargetDecision>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Headers that describe a request body; dropped when a redirect rewrites the method to GET (Fetch spec). */
const REQUEST_BODY_HEADERS = new Set([
  'content-length',
  'content-type',
  'content-encoding',
  'content-language',
  'content-location',
]);

const withoutBodyHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !REQUEST_BODY_HEADERS.has(name.toLowerCase())));

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export interface ExecuteOptions {
  /**
   * Request timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeoutMs?: number;

  /**
   * Maximum number of retry attempts.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds.
   * Actual delay uses exponential backoff: retryDelayMs * 2^attempt
   * @default 1000 (1 second)
   */
  retryDelayMs?: number;
}

export interface ExecuteResult {
  /**
   * Whether the request succeeded (2xx response).
   */
  success: boolean;

  /**
   * The HTTP response (present for both success and failure with HTTP response).
   */
  response?: HttpResponse;

  /**
   * Error message if the request failed.
   */
  error?: string;

  /**
   * Error type for categorization.
   */
  errorType?:
    | 'timeout'
    | 'network'
    | 'rate_limit'
    | 'client_error'
    | 'server_error'
    | 'blocked_target'
    | 'redirect_blocked';

  /**
   * Number of retry attempts made.
   */
  retries: number;
}

type GuardedFetchOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'refused'; error: string; errorType: 'blocked_target' | 'redirect_blocked' };

/**
 * Fetch with the target re-validated before every connect and redirects
 * followed manually, same-origin only, up to MAX_REDIRECTS hops.
 * Network errors and aborts propagate to the caller's retry/timeout handling.
 */
const fetchGuarded = async (
  request: HttpRequest,
  signal: AbortSignal,
  fetchFn: PinnedFetch,
  validateTarget: TargetValidator
): Promise<GuardedFetchOutcome> => {
  let url = request.url;
  let method = request.method;
  let body = request.body;
  let headers = request.headers;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const decision = await validateTarget(url, signal);
    if (!decision.ok) {
      return { kind: 'refused', error: decision.reason, errorType: 'blocked_target' };
    }

    const response = await fetchFn(url, {
      method,
      headers,
      body,
      signal,
      redirect: 'manual',
      pinnedAddresses: decision.addresses,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { kind: 'response', response };
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);

    if (!location) {
      return { kind: 'refused', error: 'Upstream redirect had no Location header', errorType: 'redirect_blocked' };
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { kind: 'refused', error: 'Upstream redirect Location is not a valid URL', errorType: 'redirect_blocked' };
    }

    if (next.origin !== new URL(url).origin) {
      return {
        kind: 'refused',
        error: `Upstream redirected to another origin (${next.origin}); not followed`,
        errorType: 'redirect_blocked',
      };
    }

    // Same-origin hop: apply the standard method rewrite and re-validate the
    // target (DNS is re-resolved and re-pinned) before connecting again.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = headers && withoutBodyHeaders(headers);
    }
    url = next.toString();
  }

  return { kind: 'refused', error: 'Too many redirects', errorType: 'redirect_blocked' };
};

/**
 * Execute an HTTP request with retry logic.
 *
 * Retry behavior:
 * - 4xx responses: No retry (except 429)
 * - 429 responses: Retry with Retry-After header or exponential backoff
 * - 5xx responses: Retry with exponential backoff
 * - Network errors: Retry with exponential backoff
 * - Timeout: No retry (returns immediately)
 */
export const executeHttpRequest = async (
  request: HttpRequest,
  options: ExecuteOptions = {},
  fetchFn: PinnedFetch = pinnedFetch,
  validateTarget: TargetValidator = (url, signal) => validateIntegrationTargetUrl(url, { signal })
): Promise<ExecuteResult> => {
  const { timeoutMs = 30000, maxRetries = 3, retryDelayMs = 1000 } = options;

  let lastError: string | undefined;
  let lastErrorType: ExecuteResult['errorType'];
  let retryCount = 0;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const outcome = await fetchGuarded(request, controller.signal, fetchFn, validateTarget);

        if (outcome.kind === 'refused') {
          clearTimeout(timeoutId);
          return {
            success: false,
            error: outcome.error,
            errorType: outcome.errorType,
            retries: retryCount,
          };
        }

        const { response } = outcome;
        const durationMs = Date.now() - startTime;

        // Parse response body
        let body: unknown;
        const contentType = response.headers.get('content-type') || '';
        try {
          if (contentType.includes('application/json')) {
            body = await response.json();
          } else {
            body = await response.text();
          }
        } catch (error) {
          // The timeout also bounds the body read: a body that stalls past it
          // is a timeout, not a successful empty response.
          if (controller.signal.aborted) throw error;
          body = null;
        } finally {
          clearTimeout(timeoutId);
        }

        // Convert Headers to plain object (forEach is available in both DOM and Node.js)
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const httpResponse: HttpResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
          durationMs,
        };

        // 4xx responses don't retry (except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return {
            success: false,
            response: httpResponse,
            error: `HTTP ${response.status}: ${response.statusText}`,
            errorType: 'client_error',
            retries: retryCount,
          };
        }

        // 429 retry with Retry-After
        if (response.status === 429) {
          lastError = 'Rate limit exceeded';
          lastErrorType = 'rate_limit';

          if (attempt < maxRetries) {
            retryCount++;
            const retryAfter = response.headers.get('Retry-After');
            const delayMs = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : retryDelayMs * Math.pow(2, attempt);

            await sleep(delayMs);
            continue;
          }

          return {
            success: false,
            response: httpResponse,
            error: lastError,
            errorType: lastErrorType,
            retries: retryCount,
          };
        }

        // 5xx retry with backoff
        if (response.status >= 500) {
          lastError = `HTTP ${response.status}: ${response.statusText}`;
          lastErrorType = 'server_error';

          if (attempt < maxRetries) {
            retryCount++;
            const delayMs = retryDelayMs * Math.pow(2, attempt);
            await sleep(delayMs);
            continue;
          }

          return {
            success: false,
            response: httpResponse,
            error: lastError,
            errorType: lastErrorType,
            retries: retryCount,
          };
        }

        // Success (2xx)
        return {
          success: true,
          response: httpResponse,
          retries: retryCount,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        // Timeout error
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            error: 'Request timeout',
            errorType: 'timeout',
            retries: retryCount,
          };
        }

        throw error;
      }
    } catch (error) {
      // Network error - retry
      lastError = error instanceof Error ? error.message : 'Network error';
      lastErrorType = 'network';

      if (attempt < maxRetries) {
        retryCount++;
        const delayMs = retryDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }

      return {
        success: false,
        error: lastError,
        errorType: lastErrorType,
        retries: retryCount,
      };
    }
  }

  // Should not reach here, but handle just in case
  return {
    success: false,
    error: lastError || 'Max retries exceeded',
    errorType: lastErrorType || 'network',
    retries: retryCount,
  };
};

/**
 * Sleep for a specified duration.
 */
const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Default execution options for integration tool calls.
 */
export const DEFAULT_EXECUTE_OPTIONS: Required<ExecuteOptions> = {
  timeoutMs: 30000, // 30 seconds
  maxRetries: 3,
  retryDelayMs: 1000, // 1 second base
};

/**
 * Execution options for time-sensitive operations.
 */
export const FAST_EXECUTE_OPTIONS: Required<ExecuteOptions> = {
  timeoutMs: 10000, // 10 seconds
  maxRetries: 1,
  retryDelayMs: 500,
};

/**
 * Execution options for long-running operations.
 */
export const LONG_EXECUTE_OPTIONS: Required<ExecuteOptions> = {
  timeoutMs: 120000, // 2 minutes
  maxRetries: 2,
  retryDelayMs: 2000,
};
