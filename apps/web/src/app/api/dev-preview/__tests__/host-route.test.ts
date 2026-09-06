/**
 * Contract tests for the preview ORIGIN route — mocked at the runtime seam
 * (`preview-runtime`, the forwarder), not the ORM: what these assert is the
 * route's own discipline. The host must name the holder the path names, the
 * handshake consumes a grant for THIS host only, the cookie authenticates,
 * every refusal maps to its status and is audited, and a forward carries the
 * sprite URL the gather produced — never anything from the client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { derivePreviewCookieKey, signPreviewCookie, PREVIEW_COOKIE_NAME } from '@pagespace/lib/services/sandbox/preview/preview-grant';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, api: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-env', () => ({
  isDevPreviewEnabled: vi.fn(() => true),
  resolveDevPreviewApex: vi.fn(() => 'pagespace-preview.app'),
  isDevPreviewConfigured: vi.fn(() => true),
}));
vi.mock('@pagespace/lib/services/sandbox/sandbox-client/sprites', () => ({ resolveSpritesToken: () => 'org-token' }));
vi.mock('@/lib/dev-preview/preview-forward', () => ({ forwardPreviewRequest: vi.fn() }));
vi.mock('@/lib/dev-preview/preview-runtime', () => ({
  getPreviewCookieKey: vi.fn(),
  getPreviewGrantsStore: vi.fn(),
  resolveAppOrigin: vi.fn(() => 'https://app.pagespace.ai'),
  resolvePreviewOpenPath: vi.fn(async (holder: { kind: string; id: string }) =>
    holder.kind === 'workspace' ? `/api/agent-workspaces/${holder.id}/preview/open` : `/api/drives/d1/envs/${holder.id}/preview/open`),
  resolvePreviewTargetForRequest: vi.fn(),
}));

import { GET, POST } from '../host/[kind]/[holderId]/[[...path]]/route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewEnabled } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { forwardPreviewRequest } from '@/lib/dev-preview/preview-forward';
import { getPreviewCookieKey, getPreviewGrantsStore, resolvePreviewOpenPath, resolvePreviewTargetForRequest } from '@/lib/dev-preview/preview-runtime';

const APEX = 'pagespace-preview.app';
const KEY = derivePreviewCookieKey('s'.repeat(40));
const HOST = `env-env1.preview.${APEX}`;
const HOLDER = { kind: 'env', id: 'env1' } as const;
const consume = vi.fn();

function cookie(holder = HOLDER, expiresAt = Date.now() + 60_000): string {
  return `${PREVIEW_COOKIE_NAME}=${signPreviewCookie({ holder, userId: 'u1', expiresAt }, KEY)}`;
}

function req(path: string, init: RequestInit & { host?: string } = {}): NextRequest {
  const { host = HOST, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('host', host);
  return new NextRequest(`https://${host}/api/dev-preview/host/${HOLDER.kind}/${HOLDER.id}${path}`, { ...rest, headers });
}
const ctx = (kind = HOLDER.kind, holderId = HOLDER.id) => ({ params: Promise.resolve({ kind, holderId }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevPreviewEnabled).mockReturnValue(true);
  vi.mocked(getPreviewCookieKey).mockReturnValue(KEY);
  vi.mocked(getPreviewGrantsStore).mockReturnValue({ consume, mint: vi.fn() } as never);
});

describe('the host must be a preview host naming the holder in the path', () => {
  it('404s on the app origin even with a valid cookie — the same-origin side door does not exist', async () => {
    const res = await GET(req('/', { host: 'app.pagespace.ai', headers: { cookie: cookie() } }), ctx());
    expect(res.status).toBe(404);
    expect(resolvePreviewTargetForRequest).not.toHaveBeenCalled();
  });

  it('404s when the path names a different holder than the host', async () => {
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx('env', 'env2'))).status).toBe(404);
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx('workspace', 'env1'))).status).toBe(404);
  });

  it('404s when the feature is dark', async () => {
    vi.mocked(isDevPreviewEnabled).mockReturnValue(false);
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx())).status).toBe(404);
  });
});

describe('the handshake: /__pagespace/auth', () => {
  it('consumes the grant, installs the host-only cookie, and redirects to /', async () => {
    const cookieExpiresAt = new Date(Date.now() + 3600_000);
    consume.mockResolvedValue({ holder: HOLDER, userId: 'u1', cookieExpiresAt });
    const res = await GET(req('/__pagespace/auth?grant=g1'), ctx());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(new RegExp(`^${PREVIEW_COOKIE_NAME}=v1\\.`));
    expect(set).toContain('Secure; HttpOnly; SameSite=None; Partitioned');
    expect(set).not.toMatch(/domain=/i);
    expect(consume).toHaveBeenCalledWith({ id: 'g1', now: expect.any(Date) });
  });

  it('refuses an unknown/used grant and a grant minted for another host, and audits both', async () => {
    consume.mockResolvedValueOnce(null);
    expect((await GET(req('/__pagespace/auth?grant=g1'), ctx())).status).toBe(403);
    consume.mockResolvedValueOnce({ holder: { kind: 'env', id: 'env2' }, userId: 'u1', cookieExpiresAt: new Date() });
    expect((await GET(req('/__pagespace/auth?grant=g2'), ctx())).status).toBe(403);
    expect(vi.mocked(auditRequest).mock.calls.map((c) => (c[1].details as { reason: string }).reason)).toEqual(['grant-invalid', 'grant-holder-mismatch']);
  });

  it('never consumes on a missing grant, and only GET may redeem', async () => {
    expect((await GET(req('/__pagespace/auth'), ctx())).status).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect((await POST(req('/__pagespace/auth?grant=g1', { method: 'POST' }), ctx())).status).toBe(404);
  });

  it('answers 503 when the cookie key is not configured rather than issuing an unverifiable cookie', async () => {
    vi.mocked(getPreviewCookieKey).mockReturnValue(Buffer.alloc(0));
    consume.mockResolvedValue({ holder: HOLDER, userId: 'u1', cookieExpiresAt: new Date(Date.now() + 1000) });
    expect((await GET(req('/__pagespace/auth?grant=g1'), ctx())).status).toBe(503);
  });
});

describe('the cookie authenticates', () => {
  it('a framed navigation without a cookie is sent back to the app origin to re-mint, for both holder kinds', async () => {
    const host = `ws-ws1.preview.${APEX}`;
    const nav = new NextRequest(`https://${host}/api/dev-preview/host/workspace/ws1/`, { headers: { host, 'sec-fetch-dest': 'iframe' } });
    const res = await GET(nav, ctx('workspace', 'ws1'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.pagespace.ai/api/agent-workspaces/ws1/preview/open');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    const envNav = await GET(req('/', { headers: { 'sec-fetch-dest': 'iframe' } }), ctx());
    expect(envNav.status).toBe(302);
    expect(envNav.headers.get('location')).toBe('https://app.pagespace.ai/api/drives/d1/envs/env1/preview/open');
  });

  it('OPEN IN A NEW TAB: a top-level document navigation carries no partitioned cookie, so it is sent to the app origin to mint a fresh grant', async () => {
    const res = await GET(req('/some/deep/link', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } }), ctx());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.pagespace.ai/api/drives/d1/envs/env1/preview/open');
    expect(resolvePreviewTargetForRequest).not.toHaveBeenCalled();
  });

  it('a navigation whose holder cannot be resolved to an open route gets 401 rather than a dangling redirect', async () => {
    vi.mocked(resolvePreviewOpenPath).mockResolvedValueOnce(null);
    expect((await GET(req('/', { headers: { 'sec-fetch-dest': 'document' } }), ctx())).status).toBe(401);
  });

  it('a subresource without a cookie, with a bad cookie, an expired cookie, or another holder\'s cookie is 401 — and the gather is never asked', async () => {
    for (const c of [undefined, `${PREVIEW_COOKIE_NAME}=v1.x.y`, cookie(HOLDER, Date.now() - 1), cookie({ kind: 'env', id: 'env2' })]) {
      const res = await GET(req('/main.js', { headers: { 'sec-fetch-dest': 'script', ...(c ? { cookie: c } : {}) } }), ctx());
      expect(res.status).toBe(401);
    }
    expect(resolvePreviewTargetForRequest).not.toHaveBeenCalled();
  });
});

describe('authorize + decide, per request', () => {
  it('maps a refusal onto its status, audits authz/wake denials, and logs with attribution', async () => {
    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValueOnce({ decision: { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: 'drive_access_denied' }, authorization: { allowed: false, reason: 'drive_access_denied' } });
    const denied = await GET(req('/', { headers: { cookie: cookie() } }), ctx());
    expect(denied.status).toBe(404);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', userId: 'u1', details: expect.objectContaining({ reason: 'not-authorized', detail: 'drive_access_denied' }) }));

    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValueOnce({ decision: { kind: 'refuse', reason: 'wake-denied', status: 403, message: 'asleep', detail: 'tier_ineligible' }, authorization: { allowed: false, reason: 'x' } });
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx())).status).toBe(403);

    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValueOnce({ decision: { kind: 'refuse', reason: 'preview-starting', status: 503, message: 'starting' }, authorization: { allowed: false, reason: 'x' } });
    const starting = await GET(req('/', { headers: { cookie: cookie() } }), ctx());
    expect(starting.status).toBe(503);
    expect(starting.headers.get('retry-after')).toBe('2');

    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValueOnce({ decision: { kind: 'refuse', reason: 'stale-instance', status: 409, message: 'rebuilt' }, authorization: { allowed: false, reason: 'x' } });
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx())).status).toBe(409);
    expect(auditRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loggers.security.info).mock.calls.every((c) => c[0] === 'dev-preview.access' && (c[1] as { userId: string }).userId === 'u1')).toBe(true);
  });

  it('forwards with the sprite URL the gather produced, the raw path+query, and the org token; passes the response through', async () => {
    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValue({ decision: { kind: 'forward', wake: true }, authorization: { allowed: true, driveId: 'd', wakeSubject: { driveId: 'd', ownerId: 'o' }, sandboxId: 's' }, spriteUrl: 'https://ps-x-org.sprites.app', handle: {} as never });
    const upstream = new Response('body', { status: 201, headers: { 'x-dev': '1' } });
    vi.mocked(forwardPreviewRequest).mockResolvedValue({ kind: 'response', response: upstream, upstreamStatus: 201 });
    const res = await POST(req('/api/items?x=%2F', { method: 'POST', body: 'b', headers: { cookie: cookie(), 'content-type': 'text/plain' } }), ctx());
    expect(res).toBe(upstream);
    expect(forwardPreviewRequest).toHaveBeenCalledWith(expect.objectContaining({ pathAndQuery: '/api/items?x=%2F', spriteUrl: 'https://ps-x-org.sprites.app', token: 'org-token', appOrigin: 'https://app.pagespace.ai' }));
    expect(resolvePreviewTargetForRequest).toHaveBeenCalledWith(HOLDER, 'u1');
    expect(loggers.security.info).toHaveBeenCalledWith('dev-preview.access', expect.objectContaining({ outcome: 'forwarded', status: 201, wake: true, method: 'POST', path: '/api/items' }));
  });

  it('turns forwarder failures into 413/502/504 and logs them as limit/upstream outcomes', async () => {
    vi.mocked(resolvePreviewTargetForRequest).mockResolvedValue({ decision: { kind: 'forward', wake: false }, authorization: { allowed: true, driveId: 'd', wakeSubject: { driveId: 'd', ownerId: 'o' }, sandboxId: 's' }, spriteUrl: 'https://ps-x-org.sprites.app', handle: {} as never });
    vi.mocked(forwardPreviewRequest).mockResolvedValueOnce({ kind: 'refused', status: 413, reason: 'request-too-large' });
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx())).status).toBe(413);
    vi.mocked(forwardPreviewRequest).mockResolvedValueOnce({ kind: 'upstream-error', status: 504, reason: 'headers timeout' });
    expect((await GET(req('/', { headers: { cookie: cookie() } }), ctx())).status).toBe(504);
    expect(vi.mocked(loggers.security.warn).mock.calls.map((c) => (c[1] as { outcome: string }).outcome)).toEqual(['limit-exceeded', 'upstream-error']);
  });
});
