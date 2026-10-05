/**
 * HTTP surface of per-consumer caps on a drive's wallet (Spec WAL-7). Who may write them is the
 * service's decision, proven against Postgres in
 * packages/lib/src/billing/__tests__/consumer-caps.integration.test.ts; these pin what the ROUTE
 * adds: authentication, the token's drive scope on read, body validation, the window mapping into
 * the service, and that refusals keep the service's status and code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({
  listDriveWalletCaps: vi.fn(),
  setDriveWalletCap: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
  isMCPAuthResult: (r: { tokenType?: string }) => r.tokenType === 'mcp',
  getAllowedDriveIds: (r: { allowedDriveIds?: string[] }) => r.allowedDriveIds ?? [],
  checkMCPDriveScope: (r: { allowedDriveIds?: string[] }, driveId: string) =>
    r.allowedDriveIds && r.allowedDriveIds.length > 0 && !r.allowedDriveIds.includes(driveId)
      ? NextResponse.json({ error: 'This token does not have access to this drive' }, { status: 403 })
      : null,
}));

import { GET } from '../route';
import { PUT, DELETE } from '../[userId]/route';
import { listDriveWalletCaps, setDriveWalletCap } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions } from '@/lib/auth';

const DRIVE = 'drive-product';
const session: SessionAuthResult = { userId: 'u-ana', tokenVersion: 0, tokenType: 'session', sessionId: 's-1', role: 'user', adminRoleVersion: 0 };
const token: MCPAuthResult = { userId: 'u-ana', tokenType: 'mcp', tokenId: 't', allowedDriveIds: ['drive-other'], role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const caps = [{ userId: 'u-marcus', displayName: 'Marcus Oyelaran', dailyCapCents: 30, monthlyCapCents: 100, dailyCapCredits: '30', monthlyCapCredits: '100' }];
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://example.com/api/drives/${DRIVE}/wallet/caps${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('/api/drives/[driveId]/wallet/caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
  });

  it('WAL-7 (partial) GET lists every person\'s caps by name, as the service answers them', async () => {
    vi.mocked(listDriveWalletCaps).mockResolvedValue({ ok: true, walletId: 'w-product', caps });
    const res = await GET(req('GET', ''), { params: Promise.resolve({ driveId: DRIVE }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ walletId: 'w-product', caps });
    expect(listDriveWalletCaps).toHaveBeenCalledWith('u-ana', DRIVE, 'session');
  });

  it('a token scoped to another drive reads nothing', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token);
    const res = await GET(req('GET', ''), { params: Promise.resolve({ driveId: DRIVE }) });
    expect(res.status).toBe(403);
    expect(listDriveWalletCaps).not.toHaveBeenCalled();
  });

  it('WAL-7 (partial) PUT maps the body\'s windows to the service and answers the caps; DELETE clears', async () => {
    vi.mocked(setDriveWalletCap).mockResolvedValue({ ok: true, walletId: 'w-product', caps });
    const put = await PUT(req('PUT', '/u-marcus', { dailyCapCents: 30, monthlyCapCents: null }), { params: Promise.resolve({ driveId: DRIVE, userId: 'u-marcus' }) });
    expect(put.status).toBe(200);
    expect(setDriveWalletCap).toHaveBeenLastCalledWith('u-ana', DRIVE, 'u-marcus', { dailyCents: 30, monthlyCents: null }, 'session');
    await DELETE(req('DELETE', '/u-marcus'), { params: Promise.resolve({ driveId: DRIVE, userId: 'u-marcus' }) });
    expect(setDriveWalletCap).toHaveBeenLastCalledWith('u-ana', DRIVE, 'u-marcus', null, 'session');
  });

  it('a malformed cap is a 400 before the service is asked', async () => {
    const res = await PUT(req('PUT', '/u-marcus', { dailyCapCents: -5 }), { params: Promise.resolve({ driveId: DRIVE, userId: 'u-marcus' }) });
    expect(res.status).toBe(400);
    expect(setDriveWalletCap).not.toHaveBeenCalled();
  });

  it('a refusal keeps the service\'s status and code', async () => {
    vi.mocked(setDriveWalletCap).mockResolvedValue({ ok: false, status: 403, code: 'insufficient_role', message: 'You cannot set caps this drive\'s wallet' });
    const res = await PUT(req('PUT', '/u-marcus', {}), { params: Promise.resolve({ driveId: DRIVE, userId: 'u-marcus' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'insufficient_role' });
  });
});
