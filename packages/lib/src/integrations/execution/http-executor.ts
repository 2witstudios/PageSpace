/**
 * HTTP Executor
 *
 * Executes HTTP requests with retry logic, timeout handling,
 * and proper error categorization.
 */

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
  errorType?: 'timeout' | 'network' | 'rate_limit' | 'client_error' | 'server_error';

  /**
   * Number of retry attempts made.
   */
  retries: number;
}

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
  fetchFn: typeof fetch = fetch
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
        const response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
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
        } catch {
          body = null;
        }

        const httpResponse: HttpResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
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
          retryCount++;
          lastError = 'Rate limit exceeded';
          lastErrorType = 'rate_limit';

          if (attempt < maxRetries) {
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
          retryCount++;
          lastError = `HTTP ${response.status}: ${response.statusText}`;
          lastErrorType = 'server_error';

          if (attempt < maxRetries) {
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
      retryCount++;
      lastError = error instanceof Error ? error.message : 'Network error';
      lastErrorType = 'network';

      if (attempt < maxRetries) {
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
