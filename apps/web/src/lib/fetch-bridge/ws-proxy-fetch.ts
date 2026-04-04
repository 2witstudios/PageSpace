import type { FetchBridge } from './fetch-bridge';

type FetchFunction = typeof globalThis.fetch;

/**
 * Creates a fetch function that proxies requests through the desktop WebSocket bridge.
 * Designed to be passed as the `fetch` option to Vercel AI SDK providers.
 */
export function createWsProxyFetch(userId: string, fetchBridge: FetchBridge): FetchFunction {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Check pre-aborted signal before doing any work
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const { url, method, headers, body } = await normalizeInput(input, init);
    return fetchBridge.proxyFetch(userId, url, { method, headers, body, signal: init?.signal ?? undefined });
  };
}

async function normalizeInput(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ url: string; method: string; headers: Record<string, string>; body?: string }> {
  let url: string;
  let method: string;
  let headers: Record<string, string>;
  let body: string | undefined;

  if (input instanceof URL) {
    url = input.toString();
    method = init?.method ?? 'GET';
    headers = extractHeaders(init?.headers);
    body = await serializeBody(init?.body);
  } else if (input instanceof Request) {
    url = input.url;
    method = init?.method ?? input.method;
    // Only use init.headers if explicitly provided; otherwise fall back to Request headers
    headers = init?.headers !== undefined ? extractHeaders(init.headers) : extractHeaders(input.headers);
    body = await serializeBody(init?.body !== undefined ? init.body : input.body);
  } else {
    // string URL
    url = input;
    method = init?.method ?? 'GET';
    headers = extractHeaders(init?.headers);
    body = await serializeBody(init?.body);
  }

  return { url, method, headers, body };
}

function extractHeaders(raw?: HeadersInit | null): Record<string, string> {
  if (!raw) return {};

  // Duck-type Headers (handles cross-realm instances in jsdom/Node.js)
  if (typeof (raw as Headers).forEach === 'function' && !Array.isArray(raw)) {
    const result: Record<string, string> = {};
    (raw as Headers).forEach((value: string, key: string) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(raw)) {
    const result: Record<string, string> = {};
    for (const [key, value] of raw) {
      result[key] = value;
    }
    return result;
  }

  // Plain object
  return { ...(raw as Record<string, string>) };
}

async function serializeBody(body?: BodyInit | null): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined;

  if (typeof body === 'string') {
    // Use TextEncoder for Unicode safety (btoa fails on non-Latin1 chars)
    return uint8ArrayToBase64(new TextEncoder().encode(body));
  }

  // Uint8Array and other typed arrays
  if (ArrayBuffer.isView(body)) {
    return uint8ArrayToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }

  // ArrayBuffer (duck-type for cross-realm compatibility)
  if (body instanceof ArrayBuffer || (typeof body === 'object' && body.constructor?.name === 'ArrayBuffer')) {
    return uint8ArrayToBase64(new Uint8Array(body as ArrayBuffer));
  }

  // URLSearchParams — convert to string
  if (body instanceof URLSearchParams) {
    return uint8ArrayToBase64(new TextEncoder().encode(body.toString()));
  }

  // Blob — duck-type for cross-realm compatibility, use Response API
  if (body instanceof Blob || (typeof body === 'object' && body.constructor?.name === 'Blob')) {
    const bytes = new Uint8Array(await new Response(body as Blob).arrayBuffer());
    return uint8ArrayToBase64(bytes);
  }

  // ReadableStream
  if (body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return uint8ArrayToBase64(merged);
  }

  // Fallback: convert to string (use TextEncoder for Unicode safety)
  return uint8ArrayToBase64(new TextEncoder().encode(String(body)));
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
