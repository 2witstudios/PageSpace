/**
 * HTTP surface of a drive's wallet (Spec UI-9, SPEND-9, SPEND-10). Access and projection are
 * decided by the drive-wallet service and proven per role against Postgres in
 * packages/lib/src/services/__tests__/drive-wallet-service.integration.test.ts; here the
 * service is faked with what it answers per role, and these tests pin what the ROUTE adds:
 * authentication (reads take a session or a drive-scoped token, writes a session with CSRF),
 * the token's drive scope, body validation, the refusal mapping, and that the body is the
 * service's projection and nothing more.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { AuthError, MCPAuthResult, SessionAuthResult } from '@/lib/auth';
import type { ConsumerWalletView, LeadWalletView, OrgAdminWalletView } from '@pagespace/lib/billing/wallet-views';
import type { DriveWalletRead, WalletServiceError } from '@pagespace/lib/services/drive-wallet-service';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({
  getDriveWallet: vi.fn(),
  createDriveWallet: vi.fn(),
  updateDriveWallet: vi.fn(),
  deleteDriveWallet: vi.fn(),
  topUpDriveWallet: vi.fn(),
  donateToDrive: vi.fn(),
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
  checkMCPDriveScope: (r: { allowedDriveIds?: string[] }, driveId: string) =>
    r.allowedDriveIds && r.allowedDriveIds.length > 0 && !r.allowedDriveIds.includes(driveId)
      ? NextResponse.json({ error: 'This token does not have access to this drive' }, { status: 403 })
      : null,
}));

import { GET, POST, PATCH, DELETE } from '../route';
import { POST as TOP_UP } from '../top-up/route';
import { POST as DONATE } from '../donate/route';
import {
  getDriveWallet,
  createDriveWallet,
  updateDriveWallet,
  deleteDriveWallet,
  topUpDriveWallet,
  donateToDrive,
} from '@pagespace/lib/services/drive-wallet-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth';

const DRIVE = 'drive-product';
const context = { params: Promise.resolve({ driveId: DRIVE }) };

const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 's-1', role: 'user', adminRoleVersion: 0,
});
const token = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId, tokenType: 'mcp', tokenId: 'tok-1', allowedDriveIds, role: 'user', tokenVersion: 0, adminRoleVersion: 0,
});

const req = (method: string, path = '', body?: unknown) =>
  new Request(`https://example.com/api/drives/${DRIVE}/wallet${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// What the service answers per role, typed as the service's own results so a fixture cannot
// drift from the real response shape (the projections themselves are proven against Postgres).
const consumerWallet: ConsumerWalletView = {
  viewer: 'member', walletId: 'w-product', driveId: DRIVE, status: 'active', remainingCents: 116_442, remainingCredits: '116,442',
  myCap: { dailyRemainingCents: null, monthlyRemainingCents: null, dailyRemainingCredits: null, monthlyRemainingCredits: null },
  donationsEnabled: true, defaultSpendSource: null,
};
const { viewer: _consumerViewer, ...consumerFields } = consumerWallet;
const leadWallet: LeadWalletView = {
  ...consumerFields, viewer: 'lead', allocationCents: 120_000, spentCents: 3_558, topupRemainingCents: 0, debtCents: 0,
  periodStart: null, periodEnd: null, fallbackRule: null,
  spendByConsumer: [{ consumerKey: 'user:u-lena', userId: 'u-lena', spentCents: 1_337 }],
};
const { viewer: _leadViewer, ...leadFields } = leadWallet;
const adminWallet: OrgAdminWalletView = { ...leadFields, viewer: 'org_admin', pool: { walletId: 'w-pool', availableCents: 900_017, unallocatedCents: 780_459 } };

const memberRead: DriveWalletRead = { ok: true, viewer: 'member', actions: ['view', 'donate'], wallet: consumerWallet };
const noWalletRead = (viewer: DriveWalletRead['viewer']): DriveWalletRead => ({ ok: true, viewer, actions: [], wallet: null });

const authFailure: AuthError = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('u-marcus'));
});

describe('GET /api/drives/[driveId]/wallet', () => {
  const perRole: DriveWalletRead[] = [
    memberRead,
    { ok: true, viewer: 'guest', actions: ['view', 'donate'], wallet: { ...consumerWallet, viewer: 'guest' } },
    { ok: true, viewer: 'lead', actions: ['view', 'view_spend_by_member', 'pause', 'set_rules', 'donate'], wallet: leadWallet },
    { ok: true, viewer: 'org_admin', actions: ['view', 'view_spend_by_member', 'create', 'allocate', 'top_up', 'pause', 'set_rules', 'delete', 'donate'], wallet: adminWallet },
  ];
  it.each(perRole.map((read) => [read.viewer, read] as const))('SPEND-9 (partial) SPEND-10 (partial) a %s gets exactly the service\'s projection, nothing added', async (_viewer, read) => {
    vi.mocked(getDriveWallet).mockResolvedValue(read);
    const res = await GET(req('GET'), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ viewer: read.viewer, actions: read.actions, wallet: read.wallet });
    expect(getDriveWallet).toHaveBeenCalledWith('u-marcus', DRIVE, 'session');
  });

  it('SPEND-9 (partial) a member\'s response carries no pool balance and no other consumer\'s spend', async () => {
    vi.mocked(getDriveWallet).mockResolvedValue(memberRead);
    const text = await (await GET(req('GET'), context)).text();
    expect(text).not.toContain('900017');
    expect(text).not.toContain('u-lena');
    expect(text).not.toContain('pool');
  });

  it('a non-member gets the service\'s 404', async () => {
    vi.mocked(getDriveWallet).mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'Drive not found' });
    const res = await GET(req('GET'), context);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Drive not found', code: 'not_found' });
  });

  it('X-1 (partial) a token scoped to this drive may read it; one scoped elsewhere gets 403 and the service is never asked', async () => {
    vi.mocked(getDriveWallet).mockResolvedValue(memberRead);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', [DRIVE]));
    expect((await GET(req('GET'), context)).status).toBe(200);
    vi.mocked(getDriveWallet).mockClear();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', ['drive-other']));
    expect((await GET(req('GET'), context)).status).toBe(403);
    expect(getDriveWallet).not.toHaveBeenCalled();
  });

  it('reads accept a session or an MCP token; writes admit a token only to refuse it by name, and need CSRF', async () => {
    vi.mocked(getDriveWallet).mockResolvedValue(noWalletRead('member'));
    await GET(req('GET'), context);
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1]).toEqual({ allow: ['session', 'mcp'], requireCSRF: false });
    vi.mocked(updateDriveWallet).mockResolvedValue(noWalletRead('lead'));
    await PATCH(req('PATCH', '', { paused: true }), context);
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[1][1]).toEqual({ allow: ['session', 'mcp'], requireCSRF: true });
  });

  it('an authentication failure is returned as is', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authFailure);
    expect((await GET(req('GET'), context)).status).toBe(401);
    expect(getDriveWallet).not.toHaveBeenCalled();
  });
});

describe('POST / PATCH / DELETE /api/drives/[driveId]/wallet', () => {
  it('UI-9 (partial) creates with an allocation and answers 201', async () => {
    vi.mocked(createDriveWallet).mockResolvedValue({ ok: true, viewer: 'org_admin', actions: [], wallet: adminWallet });
    const res = await POST(req('POST', '', { allocationCents: 120_000 }), context);
    expect(res.status).toBe(201);
    expect(createDriveWallet).toHaveBeenCalledWith('u-marcus', DRIVE, { allocationCents: 120_000 }, 'session');
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', resourceType: 'drive_wallet', resourceId: DRIVE }));
  });

  it.each([
    [{ allocationCents: -1 }],
    [{ allocationCents: 1.5 }],
    [{ allocationCents: 1, extra: true }],
  ])('refuses a bad create body %j with 400 before the service', async (body) => {
    expect((await POST(req('POST', '', body), context)).status).toBe(400);
    expect(createDriveWallet).not.toHaveBeenCalled();
  });

  it('UI-9 (partial) PATCH passes only the validated fields; unknown fields and bad kinds are 400', async () => {
    vi.mocked(updateDriveWallet).mockResolvedValue({ ok: true, viewer: 'lead', actions: [], wallet: leadWallet });
    const res = await PATCH(req('PATCH', '', { paused: true, fallbackRule: null, defaultSpendSource: 'drive_wallet' }), context);
    expect(res.status).toBe(200);
    expect(updateDriveWallet).toHaveBeenCalledWith('u-marcus', DRIVE, { paused: true, fallbackRule: null, defaultSpendSource: 'drive_wallet' }, 'session');
    for (const body of [{ defaultSpendSource: 'org_pool' }, { fallbackRule: 'anything' }, { status: 'active' }]) {
      expect((await PATCH(req('PATCH', '', body), context)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('UI-9 (partial) a role that may not make a change gets the service\'s 403', async () => {
    vi.mocked(updateDriveWallet).mockResolvedValue({ ok: false, status: 403, code: 'insufficient_role', message: "You cannot allocate this drive's wallet" });
    const res = await PATCH(req('PATCH', '', { allocationCents: 5 }), context);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You cannot allocate this drive's wallet", code: 'insufficient_role' });
  });

  it('UI-9 (partial) DELETE of a wallet that moved money is 409 with its blockers', async () => {
    vi.mocked(deleteDriveWallet).mockResolvedValue({ ok: false, status: 409, code: 'wallet_in_use', message: 'pause it', blockers: ['has_money_history'] });
    const res = await DELETE(req('DELETE'), context);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'pause it', code: 'wallet_in_use', blockers: ['has_money_history'] });
    vi.mocked(deleteDriveWallet).mockResolvedValue({ ok: true });
    expect(await (await DELETE(req('DELETE'), context)).json()).toEqual({ deleted: true });
  });
});

describe('POST top-up and donate', () => {
  it.each([
    ['top-up', TOP_UP, topUpDriveWallet, 'topUp'],
    ['donate', DONATE, donateToDrive, 'donation'],
  ] as const)('WAL-3 (partial) WAL-4 (partial) %s passes amount and idempotency key through and answers the leg', async (_name, handler, service, key) => {
    vi.mocked(service).mockResolvedValue({ ok: true, legId: 'leg-1', amountCents: 1_000, paidDebtCents: 0, duplicate: false });
    const res = await handler(req('POST', '', { amountCents: 1_000, idempotencyKey: 'key-00000001' }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ [key]: { legId: 'leg-1', amountCents: 1_000, paidDebtCents: 0, duplicate: false } });
    expect(service).toHaveBeenCalledWith('u-marcus', DRIVE, { amountCents: 1_000, idempotencyKey: 'key-00000001' }, 'session');
  });

  it.each([
    [{ amountCents: 0, idempotencyKey: 'key-00000001' }],
    [{ amountCents: 10 }],
    [{ amountCents: 10, idempotencyKey: 'short' }],
    [{ amountCents: 10, idempotencyKey: 'has spaces in it' }],
  ])('refuses %j with 400 before any money moves', async (body) => {
    expect((await TOP_UP(req('POST', '', body), context)).status).toBe(400);
    expect((await DONATE(req('POST', '', body), context)).status).toBe(400);
    expect(topUpDriveWallet).not.toHaveBeenCalled();
    expect(donateToDrive).not.toHaveBeenCalled();
  });

  it('WAL-4 (partial) an uncovered donation is the service\'s 402', async () => {
    vi.mocked(donateToDrive).mockResolvedValue({ ok: false, status: 402, code: 'insufficient_funds', message: 'Your balance cannot cover this donation' });
    expect((await DONATE(req('POST', '', { amountCents: 10, idempotencyKey: 'key-00000001' }), context)).status).toBe(402);
  });

  it('money moves need CSRF on a session', async () => {
    vi.mocked(topUpDriveWallet).mockResolvedValue({ ok: true, legId: 'l', amountCents: 1, paidDebtCents: 0, duplicate: false });
    await TOP_UP(req('POST', '', { amountCents: 1, idempotencyKey: 'key-00000001' }), context);
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1]).toEqual({ allow: ['session', 'mcp'], requireCSRF: true });
  });
});

describe('[D-OW-26] an MCP/CLI token on the drive wallet', () => {
  const refusal: WalletServiceError = { ok: false, status: 403, code: 'mcp_token_cannot_move_money', message: 'An access token cannot move money or change a wallet; sign in to do this' };

  // Each row stubs its own service with the typed refusal, so no row needs a cast.
  it.each([
    ['create', () => POST(req('POST', '', { allocationCents: 1 }), context), createDriveWallet, () => vi.mocked(createDriveWallet).mockResolvedValue(refusal)],
    ['change', () => PATCH(req('PATCH', '', { paused: true }), context), updateDriveWallet, () => vi.mocked(updateDriveWallet).mockResolvedValue(refusal)],
    ['delete', () => DELETE(req('DELETE'), context), deleteDriveWallet, () => vi.mocked(deleteDriveWallet).mockResolvedValue(refusal)],
    ['top-up', () => TOP_UP(req('POST', '', { amountCents: 1, idempotencyKey: 'key-00000001' }), context), topUpDriveWallet, () => vi.mocked(topUpDriveWallet).mockResolvedValue(refusal)],
    ['donate', () => DONATE(req('POST', '', { amountCents: 1, idempotencyKey: 'key-00000001' }), context), donateToDrive, () => vi.mocked(donateToDrive).mockResolvedValue(refusal)],
  ] as const)('X-1 (partial) %s names the token credential to the service and answers its typed refusal', async (_name, call, service, stub) => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-priya', [DRIVE]));
    stub();
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: refusal.message, code: 'mcp_token_cannot_move_money' });
    expect(vi.mocked(service).mock.calls[0].at(-1)).toBe('mcp');
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('SPEND-9 (partial) a token read names the token credential, so the service answers the consumer projection', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-priya', [DRIVE]));
    vi.mocked(getDriveWallet).mockResolvedValue({ ok: true, viewer: 'member', actions: ['view'], wallet: consumerWallet });
    await GET(req('GET'), context);
    expect(getDriveWallet).toHaveBeenCalledWith('u-priya', DRIVE, 'mcp');
  });
});
