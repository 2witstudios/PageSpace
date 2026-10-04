/**
 * /api/orgs/[orgId]/billing/seats: the seat summary is for Owner and Admins only, hidden where
 * billing is off (SEAT-6), and the auto-add switch is the Owner's alone (SEAT-4).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGate, mockSummary, mockSet, mockBilling, mockAudit } = vi.hoisted(() => ({
  mockGate: vi.fn(),
  mockSummary: vi.fn(),
  mockSet: vi.fn(),
  mockBilling: vi.fn(() => true),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/orgs/org-route-auth', () => ({
  authorizeOrgRequest: mockGate,
  orgsDisabledResponse: () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
  ORG_READ_AUTH: {},
  ORG_WRITE_AUTH: {},
}));
vi.mock('@pagespace/lib/organizations/seat-service', () => ({ getSeatSummary: mockSummary, setSeatAutoAdd: mockSet }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mockBilling }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));

import { GET, PATCH } from '../route';

const ctx = { params: Promise.resolve({ orgId: 'org_1' }) };
const patch = (body: unknown) => new Request('http://localhost/api/orgs/org_1/billing/seats', { method: 'PATCH', body: JSON.stringify(body) });
const get = () => new Request('http://localhost/api/orgs/org_1/billing/seats');

describe('/api/orgs/[orgId]/billing/seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBilling.mockReturnValue(true);
    mockGate.mockResolvedValue({ ok: true, userId: 'u1', role: 'OWNER' });
  });

  it('SEAT-4 (partial) GET asks for Admin and returns counts with no Stripe id or price', async () => {
    mockSummary.mockResolvedValue({ members: 5, pendingInvites: 1, held: 6, included: 5, purchasedExtra: 1, purchased: 6, autoAdd: true, hasSubscription: true, currentPeriodEnd: new Date('2026-10-15T00:00:00Z') });
    const res = await GET(get(), ctx);
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), 'org_1', 'ADMIN', expect.anything());
    expect(await res.json()).toEqual({ seats: { members: 5, pendingInvites: 1, held: 6, included: 5, purchasedExtra: 1, purchased: 6, autoAdd: true, hasSubscription: true, currentPeriodEnd: '2026-10-15T00:00:00.000Z' } });
  });

  it('SEAT-4 (partial) PATCH asks for OWNER: an Admin never reaches the switch', async () => {
    mockGate.mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) });
    expect((await PATCH(patch({ autoAdd: true }), ctx)).status).toBe(403);
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), 'org_1', 'OWNER', expect.anything());
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('SEAT-4 (partial) PATCH sets auto-add, audits it, and refuses a malformed body', async () => {
    mockSet.mockResolvedValue(true);
    const res = await PATCH(patch({ autoAdd: true }), ctx);
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('org_1', true, 'u1');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: { operation: 'set_seat_auto_add', autoAdd: true } }));
    expect((await PATCH(patch({ autoAdd: 'yes' }), ctx)).status).toBe(400);
    expect((await PATCH(patch({ autoAdd: true, extra: 1 }), ctx)).status).toBe(400);
  });

  it('SEAT-4 (partial) where billing is off the route does not exist', async () => {
    mockBilling.mockReturnValue(false);
    expect((await GET(get(), ctx)).status).toBe(404);
    expect((await PATCH(patch({ autoAdd: true }), ctx)).status).toBe(404);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
