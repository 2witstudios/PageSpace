import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const { mockLookupDriveBillingFacts, mockDbLimit, mockFindOrg, mockOrgRole, mockOrgActive } = vi.hoisted(() => ({
  mockLookupDriveBillingFacts: vi.fn(),
  mockDbLimit: vi.fn(),
  mockFindOrg: vi.fn(),
  mockOrgRole: vi.fn(),
  mockOrgActive: vi.fn(),
}));

vi.mock('@pagespace/lib/organizations/repository', () => ({ findOrganizationById: mockFindOrg }));
vi.mock('@pagespace/lib/organizations/authorize', () => ({ requireOrgRole: mockOrgRole }));
vi.mock('@pagespace/lib/organizations/status', () => ({ isOrgActive: mockOrgActive }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(() => false),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mockDbLimit }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id' } }));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// The pure payer rules are real; only the drives read is faked.
vi.mock('@pagespace/lib/billing/sandbox-payer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/billing/sandbox-payer')>()),
  lookupDriveBillingFacts: mockLookupDriveBillingFacts,
}));

vi.mock('@pagespace/lib/services/app-hosting/provisioner', () => ({
  getPublishedApp: vi.fn(async () => ({ id: 'app-1', driveId: 'drive-1', guestPreset: 'small' })),
}));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', () => ({
  isDedicatedTierPurchasable: vi.fn(() => true),
}));
vi.mock('@/lib/app-hosting/dedicated-subscription', () => ({
  startDedicatedSubscription: vi.fn(async () => ({
    ok: true,
    stripeSubscriptionId: 'sub_1',
    clientSecret: 'secret_1',
    status: 'incomplete',
  })),
  cancelDedicatedSubscription: vi.fn(async () => ({ ok: true })),
}));

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { startDedicatedSubscription, cancelDedicatedSubscription } from '@/lib/app-hosting/dedicated-subscription';

const MARCUS = 'user-marcus';

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
});

const context = { params: Promise.resolve({ appId: 'app-1' }) };
const request = (method: 'POST' | 'DELETE') =>
  new Request('https://example.com/api/app-hosting/apps/app-1/dedicated', { method }) as unknown as NextRequest;

const JONO = 'user-jono';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(MARCUS));
  mockDbLimit.mockResolvedValue([{ id: MARCUS, email: 'marcus@northwind.test' }]);
  mockFindOrg.mockResolvedValue({ id: 'org-northwind', stripeCustomerId: 'cus_northwind' });
  mockOrgActive.mockResolvedValue(true);
  // Marcus leads the drive but is a plain Member of the org; Jono is its Owner.
  mockOrgRole.mockImplementation(async (userId: string) => (
    userId === JONO ? { ok: true, role: 'OWNER' } : userId === MARCUS ? { ok: true, role: 'MEMBER' } : { ok: false, status: 404, reason: 'not_member' }
  ));
});

describe('/api/app-hosting/apps/[appId]/dedicated', () => {
  it('WAL-9 (partial) lets the owner of a personal drive buy dedicated hosting on their own customer', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: null });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(200);
    expect(startDedicatedSubscription).toHaveBeenCalledWith(expect.objectContaining({ payer: { kind: 'user', user: expect.objectContaining({ id: MARCUS }) } }));
  });

  it('WAL-9 (partial) an ORG drive\'s app is bought for the ORG, on the org\'s Stripe customer, by an org Owner — never the buyer\'s or the lead\'s card', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(JONO));
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(200);
    expect(startDedicatedSubscription).toHaveBeenCalledWith(expect.objectContaining({
      payer: { kind: 'org', orgId: 'org-northwind', stripeCustomerId: 'cus_northwind', buyerUserId: JONO },
    }));
  });

  it('WAL-9 (partial) the drive lead who is only an org Member cannot buy for the org (404), and a lapsed org buys nothing new (402)', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });
    expect((await POST(request('POST'), context))?.status).toBe(404);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(JONO));
    mockOrgActive.mockResolvedValue(false);
    const lapsed = await POST(request('POST'), context);
    expect(lapsed?.status).toBe(402);
    expect(await lapsed?.json()).toMatchObject({ error: 'org_lapsed' });
    expect(startDedicatedSubscription).not.toHaveBeenCalled();
  });

  it('WAL-9 (partial) an org with no Stripe customer is refused by name, charging no one', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(JONO));
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });
    mockFindOrg.mockResolvedValue({ id: 'org-northwind', stripeCustomerId: null });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: 'org_billing_unavailable' });
    expect(startDedicatedSubscription).not.toHaveBeenCalled();
  });

  it('an org Owner may CANCEL even while the org is lapsed — a cancel can only stop a charge', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(JONO));
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });
    mockOrgActive.mockResolvedValue(false);

    await DELETE(request('DELETE'), context);

    expect(cancelDedicatedSubscription).toHaveBeenCalledTimes(1);
  });

  it('answers 404 to anyone who does not own a personal drive', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: 'someone-else', orgId: null });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(404);
    expect(startDedicatedSubscription).not.toHaveBeenCalled();
  });
});
