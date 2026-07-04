import { NetworkError, TimeoutError } from '../errors.js';
import type { RequestDescriptor } from './types.js';

export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

export interface ExecuteRequestOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  /** Injected so tests can control abort deterministically without touching real timers/network. */
  readonly abortFactory: () => AbortController;
}

/**
 * The fetch shell: enforces a timeout via an injected AbortController and
 * maps failures to typed errors. No retry, no logging — that's the facade's
 * job (task 6).
 */
export async function executeRequest(
  descriptor: RequestDescriptor,
  options: ExecuteRequestOptions,
): Promise<RawResponse> {
  const controller = options.abortFactory();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await options.fetch(descriptor.url, {
      method: descriptor.method,
      headers: descriptor.headers,
      body: descriptor.body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { status: response.status, headers: response.headers, bodyText };
  } catch (error) {
    if (timedOut) {
      throw new TimeoutError(`Request timed out after ${options.timeoutMs}ms`, { timeoutMs: options.timeoutMs });
    }
    throw new NetworkError('Network request failed', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
