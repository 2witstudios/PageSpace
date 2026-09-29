/**
 * HTTP surface of SPEND-5's "Always my own credits" switches. What the switches DO (own
 * credits or refuse, never wider) is proven against Postgres in wallet-gate.integration.test.ts,
 * and who may set them in drive-wallet-service.integration.test.ts; these pin what the route
 * adds: authentication, body validation, the token refusal passed through by name, and the read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({
  getAlwaysOwnCredits: vi.fn(),
  setAlwaysOwnCredits: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
  isMCPAuthResult: (r: { tokenType?: string }) => r.tokenType === 'mcp',
  getAllowedDriveIds: (r: { allowedDriveIds?: string[] }) => r.allowedDriveIds ?? [],
}));

import { GET, PUT } from '../always-own-credits/route';
import { getAlwaysOwnCredits, setAlwaysOwnCredits } from '@pagespace/lib/services/drive-wallet-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth';

const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 's-1', role: 'user', adminRoleVersion: 0,
});
const token = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId, tokenType: 'mcp', tokenId: 'tok-1', allowedDriveIds, role: 'user', tokenVersion: 0, adminRoleVersion: 0,
});
const req = (method: string, url: string, body?: unknown) =>
  new Request(`https://example.com${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('u-marcus'));
});

describe('PUT /api/wallets/always-own-credits', () => {
  it('SPEND-5 (partial) turns the global switch on for the caller and audits it', async () => {
    vi.mocked(setAlwaysOwnCredits).mockResolvedValue({ ok: true, driveId: null, enabled: true });
    const res = await PUT(req('PUT', '/api/wallets/always-own-credits', { driveId: null, enabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ driveId: null, enabled: true });
    expect(setAlwaysOwnCredits).toHaveBeenCalledWith('u-marcus', { driveId: null, enabled: true }, 'session');
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write', userId: 'u-marcus', details: { operation: 'set_always_own_credits', driveId: null, enabled: true },
    }));
  });

  it('SPEND-5 (partial) turns one drive\'s switch off', async () => {
    vi.mocked(setAlwaysOwnCredits).mockResolvedValue({ ok: true, driveId: 'd-product', enabled: false });
    const res = await PUT(req('PUT', '/api/wallets/always-own-credits', { driveId: 'd-product', enabled: false }));
    expect(res.status).toBe(200);
    expect(setAlwaysOwnCredits).toHaveBeenCalledWith('u-marcus', { driveId: 'd-product', enabled: false }, 'session');
  });

  it.each([
    ['no enabled', { driveId: null }],
    ['a non-boolean enabled', { driveId: null, enabled: 'yes' }],
    ['an empty driveId', { driveId: '', enabled: true }],
    ['an unknown key', { driveId: null, enabled: true, source: 'seat_allowance' }],
  ])('SPEND-5 (partial) refuses %s without calling the service', async (_label, body) => {
    const res = await PUT(req('PUT', '/api/wallets/always-own-credits', body));
    expect(res.status).toBe(400);
    expect(setAlwaysOwnCredits).not.toHaveBeenCalled();
  });

  it('SPEND-5 (partial) [D-OW-26] passes the service\'s token refusal through by name, and a drive it cannot open as 404', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', []));
    vi.mocked(setAlwaysOwnCredits).mockResolvedValue({ ok: false, status: 403, code: 'mcp_token_cannot_change_spend_source', message: 'sign in' });
    const refused = await PUT(req('PUT', '/api/wallets/always-own-credits', { driveId: null, enabled: true }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'mcp_token_cannot_change_spend_source' });
    expect(setAlwaysOwnCredits).toHaveBeenCalledWith('u-marcus', { driveId: null, enabled: true }, 'mcp');

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('u-marcus'));
    vi.mocked(setAlwaysOwnCredits).mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'Drive not found' });
    expect((await PUT(req('PUT', '/api/wallets/always-own-credits', { driveId: 'd-research', enabled: true }))).status).toBe(404);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});

describe('GET /api/wallets/always-own-credits', () => {
  it('SPEND-5 (partial) reads both switches, for the drive named', async () => {
    vi.mocked(getAlwaysOwnCredits).mockResolvedValue({ ok: true, alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false });
    const res = await GET(req('GET', '/api/wallets/always-own-credits?driveId=d-product'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false });
    expect(getAlwaysOwnCredits).toHaveBeenCalledWith('u-marcus', 'd-product');
  });

  it('SPEND-5 (partial) a drive-scoped token may not read the account-wide switch', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', ['d-product']));
    const res = await GET(req('GET', '/api/wallets/always-own-credits'));
    expect(res.status).toBe(403);
    expect(getAlwaysOwnCredits).not.toHaveBeenCalled();
  });
});
