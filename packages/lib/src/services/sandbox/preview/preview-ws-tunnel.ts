/**
 * The WebSocket half of the preview proxy — a raw upgrade TUNNEL.
 *
 * WHY IT LIVES OUTSIDE THE WEB TIER. A Next.js route handler answers a
 * `Request` with a `Response`; it never receives the underlying socket, so it
 * cannot complete a `101 Switching Protocols` and cannot carry a WebSocket.
 * Dev servers are half-broken without one (Vite's HMR client, Next's
 * `webpack-hmr`), so the WebSocket half is hosted by the realtime app — the
 * process that already owns long-lived sockets (`apps/realtime/src/index.ts`
 * composes the shell PTY bridge the same way: authorization gathered through
 * the SAME lib deciders the web routes use, the socket itself held here).
 * The split is honest: HTTP → web, `Upgrade: websocket` → realtime, both
 * behind the same preview host, both running the same
 * `decidePreviewForward` gate. The ingress (Caddy) routes by the `Upgrade`
 * header; that block ships with the PR as the PageSpace-Deploy item.
 *
 * WHAT THIS DOES. Given a client socket the HTTP server handed over on its
 * `'upgrade'` event, it opens ONE upstream HTTP request to the sprite URL
 * with the client's WebSocket handshake headers (allowlisted — see
 * `preview-proxy-policy.ts`), `Connection: Upgrade`, and the org token. When
 * the sprite answers `101`, it relays that status line and the allowlisted
 * response headers back to the client and pipes bytes both ways, untouched:
 * no frame parsing, no subprotocol negotiation of its own, so extensions and
 * subprotocols pass through exactly as the dev server and browser agreed.
 * Anything but a `101` is turned into a plain HTTP error to the client and
 * the upstream is dropped. Both directions carry an idle timeout, and the
 * handshake has a bounded wait (long enough to absorb a wake — the request
 * IS the wake, spike §6).
 *
 * WHAT IT DOES NOT DO. It never decides whether the request may be
 * forwarded — the caller has already run the gate and hands over a resolved
 * upstream URL derived from the authorized row. It never sees the client's
 * cookies (the caller strips them with the policy's allowlist). It logs only
 * a summary (bytes, duration, why it closed) through the caller's hook.
 */

import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { PREVIEW_PROXY_LIMITS, selectForwardableRequestHeaders, selectForwardableResponseHeaders, type HeaderMap } from './preview-proxy-policy';

/** The one thing this module needs from `http`/`https`: a request that can upgrade. Injected so tests can drive it against a local server. */
export type UpgradeRequestFn = (options: http.RequestOptions) => http.ClientRequest;

export interface TunnelWebSocketUpgradeInput {
  clientSocket: Duplex;
  /** Bytes the client sent after its handshake, handed over by the `'upgrade'` event. */
  head: Buffer;
  /** The client's request headers, flattened (`IncomingHttpHeaders` → lower-cased `HeaderMap`). */
  requestHeaders: HeaderMap;
  upstreamUrl: URL;
  token: string;
  /** Defaults by upstream protocol (`https.request` / `http.request`). */
  request?: UpgradeRequestFn;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Fired once when the tunnel is fully closed, whatever the reason. */
  onClose?: (summary: TunnelSummary) => void;
}

export interface TunnelSummary {
  /** `'established'` when a 101 was relayed; otherwise the failure that answered the client. */
  outcome: 'established' | 'upstream-rejected' | 'upstream-error' | 'handshake-timeout';
  upstreamStatus?: number;
  bytesToClient: number;
  bytesToUpstream: number;
  durationMs: number;
}

/** Pure: a minimal HTTP/1.1 error response for a socket that has not been upgraded. */
export function formatSocketHttpError(status: number, reason: string): string {
  return `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
}

/** Pure: the `101` response line + relayed headers for the client. */
export function formatUpgradeResponse(headers: HeaderMap): string {
  // Defence in depth: Node's parser already rejects a bare CR/LF in an
  // upstream header value, but these lines are written raw, so strip any
  // that would otherwise split a header (response splitting).
  const lines = Object.entries(headers).map(([name, value]) => `${name.replace(/[\r\n]/g, '')}: ${value.replace(/[\r\n]/g, '')}`);
  return ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket', ...lines, '', ''].join('\r\n');
}

function armIdleTimeout(stream: Duplex, ms: number, onIdle: () => void): void {
  const setTimeoutFn = (stream as { setTimeout?: (timeout: number, callback: () => void) => unknown }).setTimeout;
  if (typeof setTimeoutFn === 'function') setTimeoutFn.call(stream, ms, onIdle);
}

function flattenHeaders(headers: http.IncomingHttpHeaders): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function tunnelWebSocketUpgrade(input: TunnelWebSocketUpgradeInput): void {
  const {
    clientSocket,
    head,
    upstreamUrl,
    token,
    handshakeTimeoutMs = PREVIEW_PROXY_LIMITS.upstreamHeadersTimeoutMs,
    idleTimeoutMs = PREVIEW_PROXY_LIMITS.streamIdleTimeoutMs,
  } = input;
  const request = input.request ?? (upstreamUrl.protocol === 'https:' ? https.request : http.request);
  const startedAt = Date.now();
  let bytesToClient = 0;
  let bytesToUpstream = 0;
  let finished = false;

  const finish = (outcome: TunnelSummary['outcome'], upstreamStatus?: number) => {
    if (finished) return;
    finished = true;
    input.onClose?.({
      outcome,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      bytesToClient,
      bytesToUpstream,
      durationMs: Date.now() - startedAt,
    });
  };

  const failClient = (status: number, reason: string, outcome: TunnelSummary['outcome'], upstreamStatus?: number) => {
    if (clientSocket.writable) clientSocket.write(formatSocketHttpError(status, reason));
    clientSocket.destroy();
    finish(outcome, upstreamStatus);
  };

  const headers: HeaderMap = {
    ...selectForwardableRequestHeaders(input.requestHeaders, { upgrade: true }),
    host: upstreamUrl.host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    authorization: `Bearer ${token}`,
  };

  const req = request({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    method: 'GET',
    headers,
    timeout: handshakeTimeoutMs,
  });

  req.on('timeout', () => {
    req.destroy(new Error('handshake timeout'));
    failClient(504, 'Gateway Timeout', 'handshake-timeout');
  });
  req.on('error', () => {
    failClient(502, 'Bad Gateway', 'upstream-error');
  });
  req.on('response', (res) => {
    // Not an upgrade: the sprite answered with a plain response (an SSO 302
    // for a bad token, a 404 from the dev server, a hang turned 5xx). Relay
    // the status as an error and drop the upstream — never its body.
    const status = res.statusCode ?? 502;
    res.resume();
    failClient(status >= 400 && status < 600 ? status : 502, 'Upgrade Refused', 'upstream-rejected', status);
  });
  req.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    const relayed = selectForwardableResponseHeaders(flattenHeaders(res.headers));
    clientSocket.write(formatUpgradeResponse(relayed));
    if (upstreamHead.length > 0) {
      bytesToClient += upstreamHead.length;
      clientSocket.write(upstreamHead);
    }
    if (head.length > 0) {
      bytesToUpstream += head.length;
      upstreamSocket.write(head);
    }

    const closeBoth = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
      finish('established', 101);
    };
    clientSocket.on('data', (chunk: Buffer) => { bytesToUpstream += chunk.length; });
    upstreamSocket.on('data', (chunk: Buffer) => { bytesToClient += chunk.length; });
    // The upgrade event types the client side as a `Duplex`; at runtime it is
    // a `net.Socket` and carries `setTimeout`. Guarded so a non-socket Duplex
    // (a test's PassThrough) simply has no idle cut.
    armIdleTimeout(clientSocket, idleTimeoutMs, closeBoth);
    upstreamSocket.setTimeout(idleTimeoutMs, closeBoth);
    clientSocket.on('error', closeBoth);
    upstreamSocket.on('error', closeBoth);
    clientSocket.on('close', closeBoth);
    upstreamSocket.on('close', closeBoth);
    // HTTP server sockets are `allowHalfOpen`, so a peer's FIN alone leaves the
    // other side writable forever; a half-closed WebSocket is meaningless, so
    // either side ending tears both down.
    clientSocket.on('end', closeBoth);
    upstreamSocket.on('end', closeBoth);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  clientSocket.on('error', () => {
    if (!finished) req.destroy();
  });
  req.end();
}
