export const DEFAULT_TIMEOUT_MS = 30000;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number;
}

/**
 * Fetch wrapper with built-in timeout support.
 * Prevents hanging requests that could exhaust resources.
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

export const TIMEOUTS = {
  SHORT: 5000, // health checks, lightweight calls
  MEDIUM: 15000, // standard API calls
  DEFAULT: DEFAULT_TIMEOUT_MS,
  LONG: 60000, // file uploads
  EXTENDED: 120000, // large file processing
} as const;
