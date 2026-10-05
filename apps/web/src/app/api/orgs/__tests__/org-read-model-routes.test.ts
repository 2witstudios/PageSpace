/**
 * The org read-model routes (D-OW-38; UI-7): guests, drive usage, member activity. Thin: the org gate
 * (the real requireOrgRole over a faked membership lookup) at ADMIN, then one lib read model. The
 * read models are tested against real Postgres in packages/lib.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({
  listOrgSeatCaps: vi.fn(async () => ({ walletId: 'w_pool', seatAllowanceCents: 150, seats: [] })),
  getOrgPoolSplit: vi.fn(async () => ({ walletId: 'w_pool', availableCents: 0, unallocatedCents: 0, periodEnd: null, seats: { memberCount: 1, allowanceCents: 100, spentCents: 0 }, driveWallets: [], drivesWithoutWallet: [] })),
}));
vi.mock('@pagespace/lib/permissions/org-read-models', () => ({
  listOrgGuests: vi.fn(async () => [{ userId: 'u_chris', name: 'Chris Rowe', email: 'chris@partner.co', image: null, drives: [] }]),
  listOrgDriveUsage: vi.fn(async () => [{ driveId: 'd1', memberCount: 12, guestCount: 1, storageBytes: 9 }]),
  listOrgMemberActivity: vi.fn(async () => [{ userId: 'u1', driveCount: 6, lastActiveAt: null }]),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { listOrgGuests, listOrgDriveUsage, listOrgMemberActivity } from '@pagespace/lib/permissions/org-read-models';
import { getOrgPoolSplit, listOrgSeatCaps } from '@pagespace/lib/services/drive-wallet-service';
import { GET as getPool } from '../[orgId]/pool/route';
import { GET as getSeatCaps } from '../[orgId]/seat-caps/route';
import { GET as getGuests } from '../[orgId]/guests/route';
import { GET as getUsage } from '../[orgId]/drives/usage/route';
import { GET as getActivity } from '../[orgId]/members/activity/route';

const ORG = 'org_nw';
const ctx = { params: Promise.resolve({ orgId: ORG }) };
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

const routes = [
  { name: 'guests', get: getGuests, fn: listOrgGuests, keys: ['guests'] },
  { name: 'drives/usage', get: getUsage, fn: listOrgDriveUsage, keys: ['usage'] },
  { name: 'members/activity', get: getActivity, fn: listOrgMemberActivity, keys: ['activity'] },
  { name: 'seat-caps', get: getSeatCaps, fn: listOrgSeatCaps, keys: ['walletId', 'seatAllowanceCents', 'seats'] },
  { name: 'pool', get: getPool, fn: getOrgPoolSplit, keys: ['walletId', 'availableCents', 'unallocatedCents', 'periodEnd', 'seats', 'driveWallets', 'drivesWithoutWallet'] },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('u_priya'));
});

describe.each(routes)('GET /api/orgs/[orgId]/$name', ({ name, get, fn, keys }) => {
  const req = () => new Request(`https://example.test/api/orgs/${ORG}/${name}`);

  it('UI-7 (partial): an Admin or the Owner reads the model for the org in the path', async () => {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      as(role);
      const res = await get(req(), ctx);
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json())).toEqual([...keys]);
    }
    expect(fn).toHaveBeenCalledWith(ORG);
  });

  it('UI-11 (partial): a plain Member is refused and reads nothing', async () => {
    as('MEMBER');
    const res = await get(req(), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('insufficient_role');
    expect(fn).not.toHaveBeenCalled();
  });

  it('someone outside the org sees no org', async () => {
    as(null);
    expect((await get(req(), ctx)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it('is a bare 404 while orgs are dark', async () => {
    flags.orgsEnabled = false;
    const res = await get(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('a failure is a coded 500', async () => {
    as('ADMIN');
    vi.mocked(fn).mockRejectedValueOnce(new Error('boom'));
    const res = await get(req(), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('internal_error');
  });
});
