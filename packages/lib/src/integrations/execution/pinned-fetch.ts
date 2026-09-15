/**
 * Pinned fetch
 *
 * A minimal `fetch`-shaped HTTP client (node:http / node:https) whose TCP
 * connection is pinned to an address the caller has already validated. The
 * hostname is still used for the Host header and TLS SNI / certificate
 * verification, but no DNS lookup happens here — so a DNS answer that changes
 * between validation and connect (rebinding) cannot redirect a credentialed
 * request to a private address.
 *
 * Node's global `fetch` offers no per-request lookup hook without importing
 * `undici`, which is not resolvable in the web bundle; node core is.
 *
 * Redirects are never followed (the caller decides), and a `signal` abort
 * rejects with an error named `AbortError`, matching `fetch` semantics.
 */

import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

export interface PinnedRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** The validated address to connect to. Required: this client never resolves names. */
  pinnedAddress: string;
  /** Accepted for parity with `fetch`; redirects are never followed regardless. */
  redirect?: 'manual';
}

export type PinnedFetch = (url: string, init: PinnedRequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const abortError = (): Error => {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
};

/** Answers every lookup with the pinned address, in both single and `all` forms. */
const pinnedLookup = (address: string): LookupFunction => {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    const cb = callback as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number
    ) => void;
    if (typeof options === 'object' && options.all) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
};

export const pinnedFetch: PinnedFetch = (url, init) => {
  const { method, headers = {}, body, signal, pinnedAddress } = init;

  if (!pinnedAddress || isIP(pinnedAddress) === 0) {
    return Promise.reject(new Error('pinnedFetch requires a validated pinned address'));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  const target = new URL(url);
  const isTls = target.protocol === 'https:';
  const request = isTls ? https.request : http.request;
  const hostnameIsIp = isIP(target.hostname.replace(/^\[|\]$/g, '')) !== 0;

  return new Promise<Response>((resolve, reject) => {
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      lookup: pinnedLookup(pinnedAddress),
      // TLS verifies the certificate against the hostname, never the pinned IP.
      ...(isTls && !hostnameIsIp ? { servername: target.hostname } : {}),
    });

    const onAbort = () => {
      req.destroy(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (error) => {
      cleanup();
      reject(error);
    });

    req.on('response', (res) => {
      cleanup();
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }

      let responseBody: ReadableStream | null = null;
      if (NULL_BODY_STATUSES.has(status)) {
        res.resume();
      } else {
        responseBody = Readable.toWeb(res) as ReadableStream;
      }

      resolve(new Response(responseBody, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
};
