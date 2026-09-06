import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { derivePreviewCookieKey, signPreviewCookie, PREVIEW_COOKIE_NAME } from '@pagespace/lib/services/sandbox/preview/preview-grant';
import type { PreviewTarget } from '@pagespace/lib/services/sandbox/preview/preview-access';
import type { TunnelWebSocketUpgradeInput } from '@pagespace/lib/services/sandbox/preview/preview-ws-tunnel';
import { buildPreviewUpgradeHandler, previewHolderForUpgrade, type PreviewUpgradeDeps } from '../preview-upgrade';

const APEX = 'pagespace-preview.app';
const KEY = derivePreviewCookieKey('k'.repeat(40));
const NOW = new Date('2026-09-06T12:00:00Z');
const HOLDER = { kind: 'env', id: 'env1' } as const;

function cookieFor(holder = HOLDER, key = KEY): string {
  return `${PREVIEW_COOKIE_NAME}=${signPreviewCookie({ holder, userId: 'u1', expiresAt: NOW.getTime() + 60_000 }, key)}`;
}

function req(over: Partial<{ host: string; cookie: string; url: string; extra: Record<string, string> }> = {}): IncomingMessage {
  return {
    url: over.url ?? '/ws',
    headers: {
      host: over.host ?? `env-env1.preview.${APEX}`,
      ...(over.cookie !== undefined ? { cookie: over.cookie } : {}),
      'sec-websocket-key': 'k',
      ...over.extra,
    },
  } as unknown as IncomingMessage;
}

function fakeSocket() {
  const socket = new PassThrough();
  const written: string[] = [];
  socket.on('data', (c: Buffer) => written.push(c.toString()));
  let destroyed = false;
  const original = socket.destroy.bind(socket);
  socket.destroy = ((error?: Error) => { destroyed = true; return original(error); }) as typeof socket.destroy;
  return { socket, written, destroyed: () => destroyed };
}

const forward: PreviewTarget = {
  decision: { kind: 'forward', wake: true },
  authorization: { allowed: true, driveId: 'd', wakeSubject: { driveId: 'd', ownerId: 'o' }, sandboxId: 's' },
  spriteUrl: 'https://ps-x-org.sprites.app',
  handle: {} as PreviewTarget extends { handle: infer H } ? H : never,
};

function deps(over: Partial<PreviewUpgradeDeps> = {}) {
  const tunnelled: TunnelWebSocketUpgradeInput[] = [];
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const d: PreviewUpgradeDeps = {
    resolveApex: () => APEX,
    cookieKey: () => KEY,
    resolveTarget: async () => forward,
    tunnel: (input) => { tunnelled.push(input); },
    spritesToken: () => 'org-token',
    log: {
      info: (message, context) => logs.push({ level: 'info', message, context }),
      warn: (message, context) => logs.push({ level: 'warn', message, context }),
      error: (message, _e, context) => logs.push({ level: 'error', message, context }),
    },
    now: () => NOW,
    ...over,
  };
  return { deps: d, tunnelled, logs };
}

describe('buildPreviewUpgradeHandler', () => {
  it('ignores an upgrade that is not for a preview host (dark feature or foreign host) and touches nothing', async () => {
    const dark = deps({ resolveApex: () => null });
    const s1 = fakeSocket();
    expect(await buildPreviewUpgradeHandler(dark.deps)(req(), s1.socket, Buffer.alloc(0))).toBe(false);
    const foreign = deps();
    const s2 = fakeSocket();
    expect(await buildPreviewUpgradeHandler(foreign.deps)(req({ host: 'app.pagespace.ai' }), s2.socket, Buffer.alloc(0))).toBe(false);
    expect(s1.destroyed() || s2.destroyed()).toBe(false);
    expect(dark.tunnelled.length + foreign.tunnelled.length).toBe(0);
  });

  it('refuses 401 without a cookie, with a bad cookie, and with a cookie for another holder — never reaching the gather', async () => {
    const resolveTarget = vi.fn(async () => forward);
    const d = deps({ resolveTarget });
    const handler = buildPreviewUpgradeHandler(d.deps);
    for (const cookie of [undefined, `${PREVIEW_COOKIE_NAME}=garbage`, cookieFor({ kind: 'env', id: 'env2' }), cookieFor(HOLDER, derivePreviewCookieKey('x'.repeat(40)))]) {
      const s = fakeSocket();
      expect(await handler(req({ cookie }), s.socket, Buffer.alloc(0))).toBe(true);
      expect(s.written.join('')).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
      expect(s.destroyed()).toBe(true);
    }
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('refuses with the gate status when the gather refuses, and logs the refusal with attribution', async () => {
    const d = deps({
      resolveTarget: async () => ({ decision: { kind: 'refuse', reason: 'stale-instance', status: 409, message: 'rebuilt' }, authorization: { allowed: false, reason: 'x' } }),
    });
    const s = fakeSocket();
    expect(await buildPreviewUpgradeHandler(d.deps)(req({ cookie: cookieFor() }), s.socket, Buffer.alloc(0))).toBe(true);
    expect(s.written.join('')).toMatch(/^HTTP\/1\.1 409 stale-instance\r\n/);
    expect(d.tunnelled).toHaveLength(0);
    expect(d.logs[0]).toMatchObject({ level: 'info', message: 'dev-preview.access', context: { userId: 'u1', holderKind: 'env', holderId: 'env1', outcome: 'refused', reason: 'stale-instance', status: 409, transport: 'websocket' } });
  });

  it('answers 502 when the gather throws', async () => {
    const d = deps({ resolveTarget: async () => { throw new Error('db down'); } });
    const s = fakeSocket();
    expect(await buildPreviewUpgradeHandler(d.deps)(req({ cookie: cookieFor() }), s.socket, Buffer.alloc(0))).toBe(true);
    expect(s.written.join('')).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    expect(d.logs[0]).toMatchObject({ level: 'error', message: 'dev-preview: upgrade gather failed' });
  });

  it('tunnels a forward: upstream from the sprite URL + the request path, the org token, the client headers, the head bytes', async () => {
    const d = deps();
    const s = fakeSocket();
    const head = Buffer.from('early');
    expect(await buildPreviewUpgradeHandler(d.deps)(req({ cookie: cookieFor(), url: '/@vite/client?x=1', extra: { 'sec-websocket-protocol': 'vite-hmr' } }), s.socket, head)).toBe(true);
    expect(d.tunnelled).toHaveLength(1);
    const input = d.tunnelled[0];
    expect(input.upstreamUrl.toString()).toBe('https://ps-x-org.sprites.app/@vite/client?x=1');
    expect(input.token).toBe('org-token');
    expect(input.head).toBe(head);
    expect(input.clientSocket).toBe(s.socket);
    expect(input.requestHeaders['sec-websocket-protocol']).toBe('vite-hmr');
    expect(input.requestHeaders.cookie).toBeDefined(); // the tunnel's allowlist drops it; the handler passes the raw map

    input.onClose?.({ outcome: 'established', upstreamStatus: 101, bytesToClient: 10, bytesToUpstream: 4, durationMs: 7 });
    expect(d.logs.at(-1)).toMatchObject({ level: 'info', message: 'dev-preview.access', context: { userId: 'u1', holderKind: 'env', holderId: 'env1', outcome: 'forwarded', reason: 'established', status: 101, wake: true, bytesOut: 10, durationMs: 7, transport: 'websocket' } });
    input.onClose?.({ outcome: 'upstream-error', bytesToClient: 0, bytesToUpstream: 0, durationMs: 1 });
    expect(d.logs.at(-1)?.context).toMatchObject({ outcome: 'upstream-error', reason: 'upstream-error' });
    expect(d.logs.at(-1)?.context).not.toHaveProperty('status');
  });

  it('refuses 502 rather than forward to a sprite URL the policy does not trust', async () => {
    const d = deps({ resolveTarget: async () => ({ ...forward, spriteUrl: 'https://evil.example.com' }) });
    const s = fakeSocket();
    expect(await buildPreviewUpgradeHandler(d.deps)(req({ cookie: cookieFor() }), s.socket, Buffer.alloc(0))).toBe(true);
    expect(s.written.join('')).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    expect(d.tunnelled).toHaveLength(0);
    expect(d.logs[0]).toMatchObject({ level: 'error', message: 'dev-preview: refused upstream' });
  });

  it('defaults a missing url to / and tolerates a socket that is no longer writable', async () => {
    const d = deps({ resolveTarget: async () => ({ decision: { kind: 'refuse', reason: 'no-preview', status: 404, message: 'none' }, authorization: { allowed: false, reason: 'x' } }) });
    const s = fakeSocket();
    s.socket.end();
    await new Promise((r) => setImmediate(r));
    const request = req({ cookie: cookieFor() });
    (request as { url?: string }).url = undefined;
    expect(await buildPreviewUpgradeHandler(d.deps)(request, s.socket, Buffer.alloc(0))).toBe(true);
    expect(d.logs[0]?.context).toMatchObject({ path: '/' });
  });

  it('refuses a cross-origin websocket handshake (frame-ancestors does not govern WebSocket) and records it; admits its own origin and no Origin', async () => {
    const d = deps();
    const handler = buildPreviewUpgradeHandler(d.deps);
    const foreign = fakeSocket();
    expect(await handler(req({ cookie: cookieFor(), extra: { origin: 'https://evil.example.com' } }), foreign.socket, Buffer.alloc(0))).toBe(true);
    expect(foreign.written.join('')).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(d.logs[0]).toMatchObject({ level: 'warn', message: 'dev-preview: cross-origin websocket refused', context: { origin: 'https://evil.example.com', audit: 'authz.access.denied' } });
    expect(d.tunnelled).toHaveLength(0);

    const own = fakeSocket();
    expect(await handler(req({ cookie: cookieFor(), extra: { origin: `https://ENV-env1.preview.${APEX}` } }), own.socket, Buffer.alloc(0))).toBe(true);
    const none = fakeSocket();
    expect(await handler(req({ cookie: cookieFor() }), none.socket, Buffer.alloc(0))).toBe(true);
    expect(d.tunnelled).toHaveLength(2);
  });

  it('tunnels a previewed app\'s own /socket.io/ upgrade — the host decides, never the path', async () => {
    const d = deps();
    const s = fakeSocket();
    expect(await buildPreviewUpgradeHandler(d.deps)(req({ cookie: cookieFor(), url: '/socket.io/?EIO=4&transport=websocket' }), s.socket, Buffer.alloc(0))).toBe(true);
    expect(d.tunnelled[0].upstreamUrl.toString()).toBe('https://ps-x-org.sprites.app/socket.io/?EIO=4&transport=websocket');
    expect(previewHolderForUpgrade({ headers: { host: `env-env1.preview.${APEX}` } }, APEX)).toEqual({ kind: 'env', id: 'env1' });
    expect(previewHolderForUpgrade({ headers: { host: `env-env1.preview.${APEX}` } }, null)).toBeNull();
  });

  it('flattens array-valued and undefined request headers, and reports non-Error throws', async () => {
    const d = deps();
    const s = fakeSocket();
    const request = req({ cookie: cookieFor() });
    (request.headers as Record<string, unknown>)['sec-websocket-extensions'] = ['a', 'b'];
    (request.headers as Record<string, unknown>)['x-undefined'] = undefined;
    expect(await buildPreviewUpgradeHandler(d.deps)(request, s.socket, Buffer.alloc(0))).toBe(true);
    expect(d.tunnelled[0].requestHeaders['sec-websocket-extensions']).toBe('a, b');
    expect('x-undefined' in d.tunnelled[0].requestHeaders).toBe(false);

    const thrower = deps({ resolveTarget: async () => { throw 'string failure'; } });
    const t = fakeSocket();
    expect(await buildPreviewUpgradeHandler(thrower.deps)(req({ cookie: cookieFor() }), t.socket, Buffer.alloc(0))).toBe(true);
    expect(thrower.logs[0]).toMatchObject({ level: 'error', message: 'dev-preview: upgrade gather failed' });

    const badUrl = deps({ resolveTarget: async () => ({ ...forward, spriteUrl: 'not a url' }) });
    const b = fakeSocket();
    expect(await buildPreviewUpgradeHandler(badUrl.deps)(req({ cookie: cookieFor() }), b.socket, Buffer.alloc(0))).toBe(true);
    expect(b.written.join('')).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
  });
});
