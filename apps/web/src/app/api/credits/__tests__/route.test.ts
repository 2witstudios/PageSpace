import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const createMockRequest = (url: string): NextRequest =>
  new Request(url) as unknown as NextRequest;

const mockSelectWhere = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockSelectWhere })) })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));

vi.mock('@/lib/auth/auth-helpers', () => ({ requireAuth: vi.fn(), isAuthError: vi.fn() }));

const { mockGetCreditBalance } = vi.hoisted(() => ({ mockGetCreditBalance: vi.fn() }));
vi.mock('@/lib/subscription/credit-balance', () => ({ getCreditBalance: mockGetCreditBalance }));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { GET } from '../route';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const summary = {
  billingEnabled: true,
  monthly: { remaining: 350, allowance: 500, periodEnd: null },
  topup: { remaining: 1000 },
  debt: 0,
  spendable: 1350,
  reserved: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ userId: 'u1' } as never);
  vi.mocked(isAuthError).mockReturnValue(false);
  mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
  mockGetCreditBalance.mockResolvedValue(summary);
});

describe('GET /api/credits', () => {
  it('returns the user balance summary', async () => {
    const res = await GET(createMockRequest('https://example.com/api/credits'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
  });

  it("resolves the user's tier and passes it to getCreditBalance", async () => {
    await GET(createMockRequest('https://example.com/api/credits'));
    expect(mockGetCreditBalance).toHaveBeenCalledWith('u1', 'pro');
  });

  it('defaults the tier to free when the user row is missing', async () => {
    mockSelectWhere.mockResolvedValue([]);
    await GET(createMockRequest('https://example.com/api/credits'));
    expect(mockGetCreditBalance).toHaveBeenCalledWith('u1', 'free');
  });

  it('returns the auth error response when unauthenticated', async () => {
    const unauth = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(requireAuth).mockResolvedValue(unauth as never);
    vi.mocked(isAuthError).mockReturnValue(true);
    const res = await GET(createMockRequest('https://example.com/api/credits'));
    expect(res.status).toBe(401);
    expect(mockGetCreditBalance).not.toHaveBeenCalled();
  });

  it('logs a read audit event', async () => {
    await GET(createMockRequest('https://example.com/api/credits'));
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.read', resourceType: 'credit_balance' }),
    );
  });

  it('returns 500 on an unexpected failure', async () => {
    mockGetCreditBalance.mockRejectedValue(new Error('boom'));
    const res = await GET(createMockRequest('https://example.com/api/credits'));
    expect(res.status).toBe(500);
  });
});
