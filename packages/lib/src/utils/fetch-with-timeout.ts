/**
 * Default timeout for external API calls (30 seconds)
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Custom error class for timeout errors.
 * Allows distinguishing timeout errors from other fetch errors.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Timeout in milliseconds. Defaults to DEFAULT_TIMEOUT_MS (30s) */
  timeout?: number;
}

/**
 * Fetch wrapper with built-in timeout support.
 * Prevents hanging requests that could exhaust resources.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options plus optional timeout
 * @returns Promise resolving to the Response
 * @throws TimeoutError if the request exceeds the timeout
 *
 * @example
 * // With default timeout (30s)
 * const response = await fetchWithTimeout('https://api.example.com/data');
 *
 * @example
 * // With custom timeout (5s)
 * const response = await fetchWithTimeout('https://api.stripe.com/v1/charges', {
 *   method: 'POST',
 *   timeout: 5000,
 *   headers: { Authorization: 'Bearer sk_...' },
 * });
 */
export const fetchWithTimeout = async (
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> => {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const effectiveTimeout = timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, effectiveTimeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(
        `Request to ${url} timed out after ${effectiveTimeout}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Predefined timeout values for different use cases
 */
export const TIMEOUTS = {
  /** Quick health checks and lightweight API calls */
  SHORT: 5000,
  /** Standard API calls */
  MEDIUM: 15000,
  /** Default timeout for most operations */
  DEFAULT: DEFAULT_TIMEOUT_MS,
  /** Long-running operations like file uploads */
  LONG: 60000,
  /** Extended operations like large file processing */
  EXTENDED: 120000,
} as const;
