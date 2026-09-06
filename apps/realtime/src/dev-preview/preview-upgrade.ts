/**
 * The WebSocket half of the preview proxy, as the realtime HTTP server's
 * `'upgrade'` handler.
 *
 * Every dependency is injected (the cookie key, the gather, the tunnel, the
 * token, the log) so the handler is a pure composition that tests drive with
 * fakes; `index.ts` binds the real ones. The rules it composes are the lib's:
 * host naming (`preview-host.ts`), cookie verification (`preview-grant.ts`),
 * the per-request gate (`preview-access.ts` → `decidePreviewForward`), the
 * header allowlist and the tunnel itself (`preview-ws-tunnel.ts`).
 *
 * Returns `true` when it took the socket (handled or refused), `false` when
 * the request was not for a preview host — then the caller's other upgrade
 * handling (socket.io) applies.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { parsePreviewHost } from '@pagespace/lib/services/sandbox/preview/preview-host';
import { readPreviewCookie, verifyPreviewCookie } from '@pagespace/lib/services/sandbox/preview/preview-grant';
import type { PreviewTarget } from '@pagespace/lib/services/sandbox/preview/preview-access';
import { buildPreviewAccessLog, buildPreviewUpstreamUrl, type HeaderMap } from '@pagespace/lib/services/sandbox/preview/preview-proxy-policy';
import { formatSocketHttpError, type TunnelSummary, type TunnelWebSocketUpgradeInput } from '@pagespace/lib/services/sandbox/preview/preview-ws-tunnel';

export interface PreviewUpgradeDeps {
  /** The configured apex, or null when the feature is dark (then no host is a preview host). */
  resolveApex(): string | null;
  cookieKey(): Buffer;
  resolveTarget(holder: DevPreviewHolderRef, userId: string): Promise<PreviewTarget>;
  tunnel(input: TunnelWebSocketUpgradeInput): void;
  spritesToken(): string;
  log: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, error?: Error, context?: Record<string, unknown>): void;
  };
  now(): Date;
}

function flatten(headers: IncomingMessage['headers']): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) socket.write(formatSocketHttpError(status, reason));
  socket.destroy();
}

export function buildPreviewUpgradeHandler(deps: PreviewUpgradeDeps) {
  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> => {
    const apex = deps.resolveApex();
    const holder = apex === null ? null : parsePreviewHost(req.headers.host, apex);
    if (holder === null) return false;

    const path = req.url ?? '/';
    const token = readPreviewCookie(req.headers.cookie);
    const verified = token === null ? null : verifyPreviewCookie(token, deps.cookieKey(), deps.now());
    if (verified === null || !verified.ok || verified.claims.holder.kind !== holder.kind || verified.claims.holder.id !== holder.id) {
      refuse(socket, 401, 'Unauthorized');
      return true;
    }
    const userId = verified.claims.userId;

    let target: PreviewTarget;
    try {
      target = await deps.resolveTarget(holder, userId);
    } catch (error) {
      deps.log.error('dev-preview: upgrade gather failed', error instanceof Error ? error : new Error(String(error)), { holderKind: holder.kind, holderId: holder.id });
      refuse(socket, 502, 'Bad Gateway');
      return true;
    }
    if (target.decision.kind === 'refuse') {
      deps.log.info('dev-preview.access', buildPreviewAccessLog({ userId, holder, method: 'GET', path, outcome: 'refused', reason: target.decision.reason, status: target.decision.status, transport: 'websocket' }));
      refuse(socket, target.decision.status, target.decision.reason);
      return true;
    }

    const { wake } = target.decision;
    let upstreamUrl: URL;
    try {
      upstreamUrl = buildPreviewUpstreamUrl(target.spriteUrl, path);
    } catch (error) {
      deps.log.error('dev-preview: refused upstream', error instanceof Error ? error : new Error(String(error)), { holderKind: holder.kind, holderId: holder.id });
      refuse(socket, 502, 'Bad Gateway');
      return true;
    }
    deps.tunnel({
      clientSocket: socket,
      head,
      requestHeaders: flatten(req.headers),
      upstreamUrl,
      token: deps.spritesToken(),
      onClose: (summary: TunnelSummary) => {
        deps.log.info('dev-preview.access', buildPreviewAccessLog({
          userId,
          holder,
          method: 'GET',
          path,
          outcome: summary.outcome === 'established' ? 'forwarded' : 'upstream-error',
          reason: summary.outcome,
          ...(summary.upstreamStatus !== undefined ? { status: summary.upstreamStatus } : {}),
          wake,
          bytesOut: summary.bytesToClient,
          durationMs: summary.durationMs,
          transport: 'websocket',
        }));
      },
    });
    return true;
  };
}
