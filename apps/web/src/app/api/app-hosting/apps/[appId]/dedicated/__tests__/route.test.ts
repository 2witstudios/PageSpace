import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const { mockLookupDriveBillingFacts, mockDbLimit } = vi.hoisted(() => ({
  mockLookupDriveBillingFacts: vi.fn(),
  mockDbLimit: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(MARCUS));
  mockDbLimit.mockResolvedValue([{ id: MARCUS, email: 'marcus@northwind.test' }]);
});

describe('/api/app-hosting/apps/[appId]/dedicated', () => {
  it('lets the owner of a personal drive buy dedicated hosting (control)', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: null });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(200);
    expect(startDedicatedSubscription).toHaveBeenCalledTimes(1);
  });

  it('WAL-9 (partial) refuses to buy for an ORG drive by name — the lead\'s card is never charged for the org\'s app', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: 'org_billing_pending' });
    expect(startDedicatedSubscription).not.toHaveBeenCalled();
  });

  it('still lets the lead CANCEL on an org drive — a cancel can only stop a charge', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: MARCUS, orgId: 'org-northwind' });

    await DELETE(request('DELETE'), context);

    expect(cancelDedicatedSubscription).toHaveBeenCalledTimes(1);
  });

  it('answers 404 to anyone who does not own the drive, before saying anything about orgs', async () => {
    mockLookupDriveBillingFacts.mockResolvedValue({ ownerId: 'someone-else', orgId: 'org-northwind' });

    const response = await POST(request('POST'), context);

    expect(response?.status).toBe(404);
    expect(startDedicatedSubscription).not.toHaveBeenCalled();
  });
});
