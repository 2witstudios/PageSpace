import { isAllowedFetchProxyURL } from '../shared/fetch-proxy-security';
import type { FetchProxyRequest } from '../shared/fetch-proxy-types';
import { FETCH_PROXY_CHUNK_SIZE, FETCH_PROXY_TIMEOUT_MS, FETCH_PROXY_MAX_CONCURRENT } from '../shared/fetch-proxy-types';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

let activeRequests = 0;

/** Reset active request count (for testing) */
export function resetActiveRequests(): void {
  activeRequests = 0;
}

/**
 * Handle a fetch proxy request by validating the URL, making the HTTP request
 * to the local AI provider, and streaming the response back via sendMessage.
 */
export async function handleFetchProxyRequest(
  request: FetchProxyRequest,
  sendMessage: (msg: WebSocketMessage) => void
): Promise<void> {
  const { id, url } = request;

  if (!isAllowedFetchProxyURL(url)) {
    sendMessage({ type: 'fetch_response_error', id, error: 'URL not allowed for proxy' });
    return;
  }

  if (activeRequests >= FETCH_PROXY_MAX_CONCURRENT) {
    sendMessage({ type: 'fetch_response_error', id, error: 'Too many concurrent fetch proxy requests' });
    return;
  }

  activeRequests++;
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body ? Buffer.from(request.body, 'base64') : undefined,
      signal: AbortSignal.timeout(FETCH_PROXY_TIMEOUT_MS),
    });

    sendMessage({
      type: 'fetch_response_start',
      id,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += FETCH_PROXY_CHUNK_SIZE) {
          const slice = value.slice(offset, offset + FETCH_PROXY_CHUNK_SIZE);
          sendMessage({
            type: 'fetch_response_chunk',
            id,
            chunk: Buffer.from(slice).toString('base64'),
          });
        }
      }
    }

    sendMessage({ type: 'fetch_response_end', id });
  } catch (error) {
    sendMessage({
      type: 'fetch_response_error',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeRequests--;
  }
}
