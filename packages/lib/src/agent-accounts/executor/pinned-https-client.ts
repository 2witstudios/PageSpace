/**
 * `createPinnedHttpsClient` — the HTTP executor's network shell (L2·G2; task
 * item 4). I/O only: every decision is pure (`decidePinnedAddress`,
 * `buildOutboundRequest`, `decideDestination`, `filterResponse`); this file
 * resolves, connects, sends and reads under limits, and reports what happened.
 *
 * - DNS pinning. The hostname is resolved ONCE; every answer is classified by
 *   the injected `isPublic` (`isPublicIp` in production) and
 *   `decidePinnedAddress` picks the address — or refuses the whole answer if
 *   any record is not public. The socket connects to exactly that address
 *   (a `lookup` that returns only it), and TLS verifies the certificate
 *   against the HOSTNAME, so a rebinding second answer can neither redirect
 *   the connection nor pass certificate checks for another name.
 * - No redirects (Node's client never follows), no decompression (bytes are
 *   read as sent; an encoded body is released as binary, i.e. omitted), no
 *   upgrades (a 101 or `upgrade` event destroys the socket), no connection
 *   reuse (`agent: false`), no proxy (never consulted).
 * - Limits: total time, response bytes (reading stops at the cap and the
 *   response is marked truncated), in-flight requests per process.
 * - Phase: a failure before the TLS handshake completed is `before_send` —
 *   nothing reached the upstream, a retry is safe (`decideRetry`); anything
 *   later is `after_send`, where a non-idempotent write may have landed.
 */
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { OutboundRequest } from '../build-outbound-request';
import { decidePinnedAddress } from '../decide-pinned-address';

export type PinnedHttpsLimits = {
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
};

export type SendOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: Uint8Array; readonly truncated: boolean }
  /** Refused before any socket was opened. */
  | { readonly kind: 'refused'; readonly reason: 'dns_failed' | 'no_address' | 'non_public_address' | 'busy' }
  | { readonly kind: 'failed'; readonly phase: 'before_send' | 'after_send'; readonly reason: 'tls' | 'connect' | 'timeout' | 'upgrade_refused' | 'network' };

export type PinnedHttpsClient = { readonly send: (request: OutboundRequest) => Promise<SendOutcome> };

export type ResolveHost = (hostname: string) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;

export const DEFAULT_PINNED_HTTPS_LIMITS: PinnedHttpsLimits = { totalTimeoutMs: 20_000, maxResponseBytes: 2 * 1024 * 1024, maxConcurrent: 16 };

export function createPinnedHttpsClient({
  resolveHost,
  isPublic,
  limits = DEFAULT_PINNED_HTTPS_LIMITS,
  ca,
}: {
  readonly resolveHost: ResolveHost;
  readonly isPublic: (address: string) => boolean;
  readonly limits?: PinnedHttpsLimits;
  /** Extra trust anchors — tests only; production uses the system store. */
  readonly ca?: string;
}): PinnedHttpsClient {
  let inFlight = 0;

  return {
    async send(outbound) {
      if (inFlight >= limits.maxConcurrent) return { kind: 'refused', reason: 'busy' };
      inFlight += 1;
      try {
        let answers: readonly { readonly address: string; readonly family: 4 | 6 }[];
        try {
          answers = await resolveHost(outbound.hostname);
        } catch {
          return { kind: 'refused', reason: 'dns_failed' };
        }
        const pinned = decidePinnedAddress({ addresses: answers.map((answer) => ({ ...answer, isPublic: isPublic(answer.address) })) });
        if (!pinned.ok) return { kind: 'refused', reason: pinned.reason };
        return await sendPinned(outbound, pinned, limits, ca);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function sendPinned(outbound: OutboundRequest, pinned: { readonly address: string; readonly family: 4 | 6 }, limits: PinnedHttpsLimits, ca: string | undefined): Promise<SendOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let handshakeDone = false;
    const settle = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const url = new URL(outbound.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of outbound.headers) headers[name] = value;

    const req = httpsRequest({
      host: outbound.hostname,
      servername: outbound.hostname,
      port: outbound.port,
      method: outbound.method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      ca,
      // The ONLY answer the socket may use: the address decidePinnedAddress chose.
      lookup: (_hostname: string, options: { readonly all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all === true) callback(null, [{ address: pinned.address, family: pinned.family } satisfies LookupAddress]);
        else callback(null, pinned.address, pinned.family);
      },
    });

    const timer = setTimeout(() => {
      req.destroy();
      settle({ kind: 'failed', phase: handshakeDone ? 'after_send' : 'before_send', reason: 'timeout' });
    }, limits.totalTimeoutMs);

    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        handshakeDone = true;
      });
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      settle({ kind: 'failed', phase: 'after_send', reason: 'upgrade_refused' });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (handshakeDone) return settle({ kind: 'failed', phase: 'after_send', reason: 'network' });
      const tls = typeof error.code === 'string' && (error.code.startsWith('ERR_TLS') || error.code.includes('CERT') || error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN');
      settle({ kind: 'failed', phase: 'before_send', reason: tls ? 'tls' : 'connect' });
    });
    req.on('response', (res) => {
      if (res.statusCode === 101) {
        res.destroy();
        req.destroy();
        return settle({ kind: 'failed', phase: 'after_send', reason: 'upgrade_refused' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const pairs: [string, string][] = [];
      for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) pairs.push([res.rawHeaders[index]!, res.rawHeaders[index + 1]!]);
      const finish = () => settle({ kind: 'response', status: res.statusCode ?? 0, headers: pairs, body: new Uint8Array(Buffer.concat(chunks)), truncated });
      res.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = limits.maxResponseBytes - size;
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, Math.max(0, room)));
          size = limits.maxResponseBytes;
          truncated = true;
          finish();
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.byteLength;
      });
      res.on('end', finish);
      res.on('error', () => settle({ kind: 'failed', phase: 'after_send', reason: 'network' }));
    });

    req.end(Buffer.from(outbound.body));
  });
}
