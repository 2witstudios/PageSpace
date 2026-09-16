/**
 * Pinned fetch
 *
 * A minimal `fetch`-shaped HTTP client (node:http / node:https) whose TCP
 * connection is pinned to addresses the caller has already validated. The
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
import { Readable, type Transform } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Sent when the caller sets no User-Agent. Global fetch always sent one, and
 * some APIs (GitHub REST) reject requests without it.
 */
export const DEFAULT_USER_AGENT = 'PageSpace-Integrations';

export interface PinnedRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * The validated addresses to connect to, in preference order. Required and
   * non-empty: this client never resolves names. Node's address fallback
   * (`net` autoSelectFamily, on by default) tries them in turn, so a dual-stack
   * target whose first address is unreachable still connects — but only ever
   * to these addresses.
   */
  pinnedAddresses: readonly string[];
  /** Accepted for parity with `fetch`; redirects are never followed regardless. */
  redirect?: 'manual';
}

export type PinnedFetch = (url: string, init: PinnedRequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Decoders for the content codings global fetch decoded. */
const DECODERS: Record<string, () => Transform> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  // Some servers send raw deflate instead of zlib-wrapped; unzip detects both.
  deflate: () => zlib.createUnzip(),
  br: () => zlib.createBrotliDecompress(),
};

/**
 * Undo `Content-Encoding` (codings apply in listed order, so decode in reverse).
 * If any coding is unknown the body passes through undecoded, as fetch does.
 */
const decodeBody = (source: Readable, contentEncoding: string | undefined): Readable => {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity')
    .reverse();
  if (codings.some((coding) => !(coding in DECODERS))) return source;
  return codings.reduce<Readable>((stream, coding) => {
    const decoder = DECODERS[coding]();
    stream.on('error', (error) => decoder.destroy(error));
    return stream.pipe(decoder);
  }, source);
};

const abortError = (): Error => {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
};

/** Answers every lookup with the pinned addresses, in both single and `all` forms. */
const pinnedLookup = (addresses: readonly string[]): LookupFunction => {
  const records = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const cb = callback as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number
    ) => void;
    if (typeof options === 'object' && options.all) {
      cb(null, records);
    } else {
      cb(null, records[0].address, records[0].family);
    }
  };
};

export const pinnedFetch: PinnedFetch = (url, init) => {
  const { method, headers = {}, body, signal, pinnedAddresses } = init;

  if (pinnedAddresses.length === 0 || pinnedAddresses.some((address) => isIP(address) === 0)) {
    return Promise.reject(new Error('pinnedFetch requires validated pinned addresses'));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  const target = new URL(url);
  const isTls = target.protocol === 'https:';
  const request = isTls ? https.request : http.request;
  const hostnameIsIp = isIP(target.hostname.replace(/^\[|\]$/g, '')) !== 0;
  // Defaults global fetch supplied and node:http does not: a User-Agent (GitHub
  // REST rejects requests without one) and, for a body, its byte length (Node
  // otherwise streams it chunked, which some servers refuse with 411). Caller
  // headers win in both cases.
  const hasHeader = (wanted: string) => Object.keys(headers).some((name) => name.toLowerCase() === wanted);
  const requestHeaders = {
    ...(hasHeader('user-agent') ? {} : { 'User-Agent': DEFAULT_USER_AGENT }),
    ...headers,
    ...(body !== undefined && !hasHeader('content-length')
      ? { 'Content-Length': String(Buffer.byteLength(body, 'utf8')) }
      : {}),
  };

  return new Promise<Response>((resolve, reject) => {
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      lookup: pinnedLookup(pinnedAddresses),
      // Never reuse a pooled keep-alive socket: the pool is keyed by host:port,
      // so a reused socket would skip this request's pinned lookup and could be
      // connected to an address from an earlier validation.
      agent: false,
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
        responseBody = Readable.toWeb(decodeBody(res, res.headers['content-encoding'])) as ReadableStream;
      }

      resolve(new Response(responseBody, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
};
