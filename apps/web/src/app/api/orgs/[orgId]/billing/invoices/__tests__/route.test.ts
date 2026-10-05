/**
 * GET /api/orgs/[orgId]/billing/invoices (Spec SEAT-6). The shell is faked; authorization is
 * NOT: the real requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true, billingEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: () => flags.billingEnabled }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@/lib/org-billing/org-subscription', async () => {
  class OrgBillingError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  return { OrgBillingError, listOrgInvoices: vi.fn() };
});

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { listOrgInvoices, OrgBillingError } from '@/lib/org-billing/org-subscription';
import { GET } from '../route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess',
  role: 'user',
  adminRoleVersion: 0,
});
const call = (query = '') =>
  GET(new Request(`https://example.test/api/orgs/${ORG_ID}/billing/invoices${query}`), { params: Promise.resolve({ orgId: ORG_ID }) });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);
const INVOICE = {
  id: 'in_1',
  number: 'NW-0001',
  status: 'paid',
  amountDue: 5000,
  amountPaid: 5000,
  currency: 'usd',
  created: '2026-10-04T00:00:00.000Z',
  periodStart: null,
  periodEnd: null,
  hostedInvoiceUrl: null,
  invoicePdf: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  flags.billingEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(listOrgInvoices).mockResolvedValue({ invoices: [INVOICE], hasMore: true });
});

describe('GET /api/orgs/[orgId]/billing/invoices', () => {
  it('SEAT-6 (partial) an Owner or Admin lists the ORG\'s invoices with paging', async () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      as(role);
      const res = await call('?limit=5&starting_after=in_prev');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ invoices: [INVOICE], hasMore: true });
    }
    expect(listOrgInvoices).toHaveBeenCalledWith(ORG_ID, { limit: 5, startingAfter: 'in_prev' });
  });

  it('defaults to 10, clamps the limit, and refuses a malformed cursor before Stripe sees it', async () => {
    as('OWNER');
    await call();
    expect(listOrgInvoices).toHaveBeenLastCalledWith(ORG_ID, { limit: 10, startingAfter: undefined });
    await call('?limit=5000');
    expect(listOrgInvoices).toHaveBeenLastCalledWith(ORG_ID, { limit: 100, startingAfter: undefined });
    vi.mocked(listOrgInvoices).mockClear();
    expect((await call('?starting_after=cus_someone_else')).status).toBe(400);
    expect(listOrgInvoices).not.toHaveBeenCalled();
  });

  it('SEAT-6 (partial) a plain Member or a non-member is refused before any Stripe call', async () => {
    as('MEMBER');
    expect((await call()).status).toBe(403);
    as(null);
    expect((await call()).status).toBe(404);
    expect(listOrgInvoices).not.toHaveBeenCalled();
  });

  it('SEAT-6 (partial) is absent where billing is off (onprem, tenant) and while orgs are dark', async () => {
    as('OWNER');
    flags.billingEnabled = false;
    expect((await call()).status).toBe(404);
    flags.billingEnabled = true;
    flags.orgsEnabled = false;
    expect((await call()).status).toBe(404);
    expect(listOrgInvoices).not.toHaveBeenCalled();
  });

  it('a vanished org is a 404, a Stripe failure a retryable 502', async () => {
    as('OWNER');
    vi.mocked(listOrgInvoices).mockRejectedValueOnce(new OrgBillingError('org_not_found', 'x'));
    expect((await call()).status).toBe(404);
    vi.mocked(listOrgInvoices).mockRejectedValueOnce(new Error('Stripe is unavailable'));
    expect((await call()).status).toBe(502);
  });
});
