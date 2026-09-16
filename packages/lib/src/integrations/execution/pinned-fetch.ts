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
import { Readable, pipeline, type Transform } from 'node:stream';
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
  if (codings.length === 0 || codings.some((coding) => !(coding in DECODERS))) return source;
  // pipeline destroys every stage when any stage errors or is destroyed early,
  // so cancelling the decoded body (or a decode error) also closes the socket.
  const decoders = codings.map((coding) => DECODERS[coding]());
  pipeline([source, ...decoders], () => undefined);
  return decoders[decoders.length - 1];
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
  // URL keeps IPv6 literals bracketed; node:https would check the certificate
  // against "[::1]". Pass the bare host (Node still brackets it in Host).
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const hostnameIsIp = isIP(hostname) !== 0;
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
      hostname,
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
      ...(isTls && !hostnameIsIp ? { servername: hostname } : {}),
    });

    let activeResponse: http.IncomingMessage | null = null;
    const onAbort = () => {
      // After headers, destroy the response too so its body read fails with an AbortError.
      activeResponse?.destroy(abortError());
      req.destroy(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (error) => {
      cleanup();
      reject(error);
    });

    // node:http emits 'upgrade' (never 'response' or 'error') for a 101 reply;
    // unhandled, the request would hang past any timeout.
    req.on('upgrade', (_res, socket) => {
      cleanup();
      socket.destroy();
      reject(new Error('Upstream switched protocols (101); not supported'));
    });

    req.on('response', (res) => {
      // Keep the abort listener until the body is done: an abort mid-body
      // destroys the socket and fails the body read with an AbortError.
      res.once('close', cleanup);
      activeResponse = res;
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
        // A HEAD response or a zero-length body has nothing to decode; running a
        // decoder over it fails with "unexpected end of file" where fetch reads ''.
        const hasNoBody = method.toUpperCase() === 'HEAD' || res.headers['content-length'] === '0';
        const contentEncoding = hasNoBody ? undefined : res.headers['content-encoding'];
        responseBody = Readable.toWeb(decodeBody(res, contentEncoding)) as ReadableStream;
      }

      // Response rejects a reason phrase outside HTAB / SP / VCHAR / obs-text;
      // fetch drops such a phrase rather than failing the request.
      const statusText = /^[\t\x20-\x7e\x80-\xff]*$/.test(res.statusMessage ?? '') ? (res.statusMessage ?? '') : '';

      // Response only represents 200-599; node:http accepts any three-digit
      // status. Throwing here would escape the socket listener uncaught and
      // leave this promise pending forever, so refuse it as a failed request.
      try {
        resolve(new Response(responseBody, { status, statusText, headers: responseHeaders }));
      } catch {
        res.destroy();
        reject(new Error(`Upstream returned an unsupported HTTP status (${status})`));
      }
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
};
