/**
 * Unit tests for GET/PUT /api/drives/[driveId]/imago-access — the per-drive
 * Imago access toggle. The real-database behaviour (real session cookie, CSRF
 * token and origin, real memberships) is in route.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in result),
}));
vi.mock('@pagespace/lib/agents/imago-drive-access', () => ({
  getImagoDriveAccess: vi.fn(),
  setImagoDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

import { GET, PUT } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getImagoDriveAccess, setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const VIEWER = 'user_viewer';
const DRIVE = 'drive_abc';

const access = (enabled: boolean) => ({
  driveId: DRIVE,
  enabled,
  agents: [{ key: 'imago' as const, agentPageId: 'agent_1', isMember: enabled }],
});

function signedIn(): SessionAuthResult {
  return { userId: VIEWER, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 };
}

const context = () => ({ params: Promise.resolve({ driveId: DRIVE }) });

const getRequest = () => new Request(`http://localhost/api/drives/${DRIVE}/imago-access`);
const putRequest = (body: unknown) =>
  new Request(`http://localhost/api/drives/${DRIVE}/imago-access`, {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(signedIn());
});

describe('GET /api/drives/[driveId]/imago-access', () => {
  it("given a drive admin, should return the viewer's Imago access for the awaited driveId", async () => {
    vi.mocked(getImagoDriveAccess).mockResolvedValue({ ok: true, access: access(true) });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(access(true));
    expect(getImagoDriveAccess).toHaveBeenCalledWith(VIEWER, DRIVE);
  });

  it('given session auth, should read without requiring a CSRF token', async () => {
    vi.mocked(getImagoDriveAccess).mockResolvedValue({ ok: true, access: access(true) });

    await GET(getRequest(), context());

    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: false });
  });

  it('given a viewer without grant rights, should return 403', async () => {
    vi.mocked(getImagoDriveAccess).mockResolvedValue({ ok: false, status: 403, error: 'Only drive owners and admins can manage Imago access' });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Only drive owners and admins can manage Imago access' });
  });

  it('given an auth failure, should return it without reading', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(getImagoDriveAccess).not.toHaveBeenCalled();
  });

  it('given the service throws, should return 500', async () => {
    vi.mocked(getImagoDriveAccess).mockRejectedValue(new Error('db down'));

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(500);
  });
});

describe('PUT /api/drives/[driveId]/imago-access', () => {
  it('given session auth, should require CSRF (and with it the origin check) like other mutating drive routes', async () => {
    vi.mocked(setImagoDriveAccess).mockResolvedValue({ ok: true, access: access(false) });

    await PUT(putRequest({ enabled: false }), context());

    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: true });
  });

  it('given a CSRF or origin failure, should return it and change nothing', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({ error: 'CSRF token required' }, { status: 403 }) });

    const response = await PUT(putRequest({ enabled: false }), context());

    expect(response.status).toBe(403);
    expect(setImagoDriveAccess).not.toHaveBeenCalled();
  });

  it.each([true, false])('given enabled=%s, should set it for the viewer on the awaited driveId and audit it', async (enabled) => {
    vi.mocked(setImagoDriveAccess).mockResolvedValue({ ok: true, access: access(enabled) });

    const response = await PUT(putRequest({ enabled }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(access(enabled));
    expect(setImagoDriveAccess).toHaveBeenCalledWith(VIEWER, DRIVE, enabled);
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), {
      eventType: enabled ? 'authz.permission.granted' : 'authz.permission.revoked',
      userId: VIEWER,
      resourceType: 'drive',
      resourceId: DRIVE,
      details: { imagoAccess: enabled, agentPageIds: ['agent_1'] },
    });
  });

  it.each([
    ['a missing field', {}],
    ['a non-boolean', { enabled: 'yes' }],
    ['extra fields', { enabled: true, userId: 'someone_else' }],
  ])('given %s, should return 400 and change nothing', async (_label, body) => {
    const response = await PUT(putRequest(body), context());

    expect(response.status).toBe(400);
    expect(setImagoDriveAccess).not.toHaveBeenCalled();
  });

  it('given a body that is not JSON, should return 400 and change nothing', async () => {
    const response = await PUT(putRequest('not json'), context());

    expect(response.status).toBe(400);
    expect(setImagoDriveAccess).not.toHaveBeenCalled();
  });

  it('given a viewer without grant rights, should return 403 and audit nothing', async () => {
    vi.mocked(setImagoDriveAccess).mockResolvedValue({ ok: false, status: 403, error: 'Only drive owners and admins can manage Imago access' });

    const response = await PUT(putRequest({ enabled: true }), context());

    expect(response.status).toBe(403);
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('given unprovisioned agents, should pass the 409 through', async () => {
    vi.mocked(setImagoDriveAccess).mockResolvedValue({ ok: false, status: 409, error: 'Your Imago agents are not set up yet' });

    const response = await PUT(putRequest({ enabled: true }), context());

    expect(response.status).toBe(409);
  });

  it('given the service throws, should return 500', async () => {
    vi.mocked(setImagoDriveAccess).mockRejectedValue(new Error('db down'));

    const response = await PUT(putRequest({ enabled: true }), context());

    expect(response.status).toBe(500);
  });
});
