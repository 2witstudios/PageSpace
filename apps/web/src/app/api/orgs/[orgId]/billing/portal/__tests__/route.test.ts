/**
 * POST /api/orgs/[orgId]/billing/portal (Spec SEAT-6). The shell is faked; authorization is
 * NOT: the real requireOrgRole runs over a faked membership lookup, so a route that skipped it
 * or asked for the wrong role fails here.
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
  return { OrgBillingError, createOrgBillingPortalSession: vi.fn() };
});

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { createOrgBillingPortalSession, OrgBillingError } from '@/lib/org-billing/org-subscription';
import { POST } from '../route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess',
  role: 'user',
  adminRoleVersion: 0,
});
const call = () =>
  POST(new Request(`https://example.test/api/orgs/${ORG_ID}/billing/portal`, { method: 'POST' }), { params: Promise.resolve({ orgId: ORG_ID }) });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);
const originalUrl = process.env.WEB_APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  flags.billingEnabled = true;
  process.env.WEB_APP_URL = originalUrl;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(createOrgBillingPortalSession).mockResolvedValue({ url: 'https://billing.stripe.com/p/session/abc' });
});

describe('POST /api/orgs/[orgId]/billing/portal', () => {
  it('SEAT-6 (partial) an Owner or Admin gets a portal session for the ORG, returning to the org settings hub', async () => {
    process.env.WEB_APP_URL = 'https://app.pagespace.test/';
    for (const role of ['OWNER', 'ADMIN'] as const) {
      as(role);
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/p/session/abc' });
    }
    expect(createOrgBillingPortalSession).toHaveBeenCalledWith(ORG_ID, `https://app.pagespace.test/orgs/${ORG_ID}/settings`);
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: 'organization', resourceId: ORG_ID, details: { operation: 'open_org_billing_portal' } }),
    );
  });

  it('SEAT-6 (partial) a plain Member or a non-member is refused before any Stripe call', async () => {
    as('MEMBER');
    expect((await call()).status).toBe(403);
    as(null);
    expect((await call()).status).toBe(404);
    expect(createOrgBillingPortalSession).not.toHaveBeenCalled();
  });

  it('SEAT-6 (partial) is absent where billing is off (onprem, tenant) and while orgs are dark', async () => {
    as('OWNER');
    flags.billingEnabled = false;
    const billingOff = await call();
    // Billing off is told apart from orgs being dark by its code (UI-7); orgs dark stays a bare 404.
    expect([billingOff.status, (await billingOff.json()).code]).toEqual([404, 'billing_unavailable']);
    flags.billingEnabled = true;
    flags.orgsEnabled = false;
    const dark = await call();
    expect(dark.status).toBe(404);
    expect(await dark.json()).toEqual({ error: 'Not found' });
    expect(createOrgBillingPortalSession).not.toHaveBeenCalled();
  });

  it('an org with no billing customer is a 409 with a code; a vanished org a 404; a Stripe failure a retryable 502', async () => {
    as('OWNER');
    vi.mocked(createOrgBillingPortalSession).mockRejectedValueOnce(new OrgBillingError('no_billing_customer', 'x'));
    const none = await call();
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe('no_billing_customer');
    vi.mocked(createOrgBillingPortalSession).mockRejectedValueOnce(new OrgBillingError('org_not_found', 'x'));
    expect((await call()).status).toBe(404);
    vi.mocked(createOrgBillingPortalSession).mockRejectedValueOnce(new Error('Stripe is unavailable'));
    expect((await call()).status).toBe(502);
  });
});
