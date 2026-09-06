/**
 * Contract tests for the two `/preview/open` routes and the capability
 * route: dark ⇒ 404; same-origin only; the route's own drive/session gate;
 * the shared gather's verdict; a 302 to the preview host's auth endpoint.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
  isPrincipalDriveMember: vi.fn(),
}));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-env', () => ({
  isDevPreviewConfigured: vi.fn(() => true),
  isDevPreviewEnabled: vi.fn(() => true),
  resolveDevPreviewApex: vi.fn(() => 'pagespace-preview.app'),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ resolveEnvInDrive: vi.fn() }));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({ findSessionRecord: vi.fn() }));
vi.mock('@/lib/agent-workspaces/workspace-unavailable-response', () => ({
  workspaceNotFoundOrDenied: vi.fn(() => new Response(null, { status: 404 })),
}));
vi.mock('@/lib/dev-preview/preview-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dev-preview/preview-runtime')>('@/lib/dev-preview/preview-runtime');
  return { isAllowedPreviewOpen: actual.isAllowedPreviewOpen, openPreviewForUser: vi.fn() };
});

import { GET as openEnv } from '../../drives/[driveId]/envs/[envId]/preview/open/route';
import { GET as openSession } from '../../agent-workspaces/[workspaceId]/preview/open/route';
import { GET as capability } from '../capability/route';
import { authenticateRequestWithOptions, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { openPreviewForUser } from '@/lib/dev-preview/preview-runtime';

const envCtx = { params: Promise.resolve({ driveId: 'd1', envId: 'env1' }) };
const wsCtx = { params: Promise.resolve({ workspaceId: 'ws1' }) };
const REDIRECT = 'https://env-env1.preview.pagespace-preview.app/__pagespace/auth?grant=g';

function req(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): Request {
  return new Request('https://app.pagespace.ai/x', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevPreviewConfigured).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'u1' } as never);
  vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  vi.mocked(resolveEnvInDrive).mockResolvedValue({ id: 'env1', driveId: 'd1' } as never);
  vi.mocked(findSessionRecord).mockResolvedValue({ id: 'ws1', envId: null } as never);
  vi.mocked(openPreviewForUser).mockResolvedValue({ ok: true, redirectTo: REDIRECT });
});

describe('GET /api/drives/[driveId]/envs/[envId]/preview/open', () => {
  it('redirects a same-origin member to the env preview host auth endpoint', async () => {
    const res = await openEnv(req(), envCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(REDIRECT);
    expect(openPreviewForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'env', id: 'env1' }, userId: 'u1' });
  });

  it('is dark (404) when the feature is not configured, before authentication', async () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValue(false);
    expect((await openEnv(req(), envCtx)).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
  });

  it.each([
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
    {},
  ])('refuses a cross-site embed / headerless open (%o) and audits it', async (headers) => {
    expect((await openEnv(req(headers), envCtx)).status).toBe(403);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ reason: 'cross-site-embed' }) }));
    expect(openPreviewForUser).not.toHaveBeenCalled();
  });

  it('OPEN IN A NEW TAB: a cross-site TOP-LEVEL navigation (the preview host re-minting after a cookie-less top-level visit) is admitted and mints a fresh grant', async () => {
    const res = await openEnv(req({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }), envCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(REDIRECT);
    expect(openPreviewForUser).toHaveBeenCalledTimes(1);
  });

  it('403s a non-member and 404s an env outside the drive', async () => {
    vi.mocked(isPrincipalDriveMember).mockResolvedValueOnce(false);
    expect((await openEnv(req(), envCtx)).status).toBe(403);
    vi.mocked(resolveEnvInDrive).mockResolvedValueOnce(null);
    expect((await openEnv(req(), envCtx)).status).toBe(404);
  });

  it('404s when the shared gather refuses, auditing the reason', async () => {
    vi.mocked(openPreviewForUser).mockResolvedValueOnce({ ok: false, reason: 'not-authorized', detail: 'env_not_sprite' });
    expect((await openEnv(req(), envCtx)).status).toBe(404);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ reason: 'env_not_sprite' }) }));
    vi.mocked(openPreviewForUser).mockResolvedValueOnce({ ok: false, reason: 'not-configured' });
    expect((await openEnv(req(), envCtx)).status).toBe(404);
  });

  it('500s on an unexpected failure', async () => {
    vi.mocked(openPreviewForUser).mockRejectedValueOnce(new Error('boom'));
    expect((await openEnv(req(), envCtx)).status).toBe(500);
  });
});

describe('GET /api/agent-workspaces/[workspaceId]/preview/open', () => {
  it('authorizes as the session and mints for the session holder', async () => {
    const res = await openSession(req(), wsCtx);
    expect(res.status).toBe(302);
    expect(openPreviewForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'workspace', id: 'ws1' }, mintFor: { kind: 'workspace', id: 'ws1' }, userId: 'u1' });
  });

  it('for an env-bound session, authorizes as the session and mints for the ENV (the holder rule)', async () => {
    vi.mocked(findSessionRecord).mockResolvedValueOnce({ id: 'ws1', envId: 'env1' } as never);
    await openSession(req(), wsCtx);
    expect(openPreviewForUser).toHaveBeenCalledWith({ authorizeAs: { kind: 'workspace', id: 'ws1' }, mintFor: { kind: 'env', id: 'env1' }, userId: 'u1' });
  });

  it('answers the family not-found/denied policy for an unknown session and for a refusal (audited)', async () => {
    vi.mocked(findSessionRecord).mockResolvedValueOnce(null);
    expect((await openSession(req(), wsCtx)).status).toBe(404);
    vi.mocked(openPreviewForUser).mockResolvedValueOnce({ ok: false, reason: 'not-authorized', detail: 'drive_access_denied' });
    expect((await openSession(req(), wsCtx)).status).toBe(404);
    expect(workspaceNotFoundOrDenied).toHaveBeenCalledWith(expect.anything(), 'u1', 'ws1', 'session_not_found', expect.any(String));
    expect(workspaceNotFoundOrDenied).toHaveBeenCalledWith(expect.anything(), 'u1', 'ws1', 'drive_access_denied', expect.any(String));
  });

  it('is dark, same-origin only, and 500s on an unexpected failure', async () => {
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect((await openSession(req(), wsCtx)).status).toBe(404);
    expect((await openSession(req({}), wsCtx)).status).toBe(403);
    expect((await openSession(req({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' }), wsCtx)).status).toBe(403);
    expect((await openSession(req({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' }), wsCtx)).status).toBe(302);
    vi.mocked(findSessionRecord).mockRejectedValueOnce(new Error('boom'));
    expect((await openSession(req(), wsCtx)).status).toBe(500);
  });
});

describe('GET /api/dev-preview/capability', () => {
  it('reports the server-derived capability', async () => {
    expect(await (await capability()).json()).toEqual({ enabled: true });
    vi.mocked(isDevPreviewConfigured).mockReturnValueOnce(false);
    expect(await (await capability()).json()).toEqual({ enabled: false });
  });
});
