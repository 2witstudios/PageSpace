/**
 * @module @/lib/fetch-bridge/ws-proxy-fetch
 * @description Creates a fetch function that proxies HTTP requests through the desktop WebSocket bridge
 *
 * STUB: The actual implementation is being built on a parallel branch (fetch-bridge-server).
 * This stub provides the correct type signature so the integration layer compiles.
 *
 * The real implementation will:
 * 1. Send a fetch_request message over the WebSocket to the desktop
 * 2. Wait for fetch_response_start (status + headers)
 * 3. Collect fetch_response_chunk messages into a ReadableStream
 * 4. Return a standard Response object that the AI SDK can consume
 */

import type { FetchBridge } from './index';

/**
 * Creates a fetch-compatible function that routes requests through the desktop WebSocket bridge.
 * Injected into AI SDK providers via their `fetch` option.
 *
 * @param userId - The user whose desktop connection to route through
 * @param bridge - The FetchBridge instance managing WebSocket communication
 * @returns A function with the same signature as global fetch
 */
export function createWsProxyFetch(
  userId: string,
  bridge: FetchBridge
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Stub: will be replaced by real implementation from fetch-bridge-server branch
    void bridge;
    void userId;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    throw new Error(
      `wsProxyFetch not implemented — merge fetch-bridge-server branch (attempted: ${url})`
    );
  };
}
