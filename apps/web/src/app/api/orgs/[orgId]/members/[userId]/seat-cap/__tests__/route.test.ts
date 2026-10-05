/**
 * HTTP surface of a member's seat caps on the org pool (Spec WAL-7). The org gate (Admin+) and
 * the service's own decision are proven elsewhere (org-route-auth tests; consumer-caps
 * integration); this pins the route's wiring: the gate runs first at ADMIN, the body maps to the
 * service, DELETE clears, and refusals keep the service's status and code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({ setSeatCap: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));
vi.mock('@/lib/orgs/org-route-auth', () => ({ authorizeOrgRequest: vi.fn(), ORG_WRITE_AUTH: { allow: ['session'], requireCSRF: true } }));

import { PUT, DELETE } from '../route';
import { setSeatCap } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest } from '@/lib/orgs/org-route-auth';

const ctx = { params: Promise.resolve({ orgId: 'org-1', userId: 'u-marcus' }) };
const req = (method: string, body?: unknown) => new Request('https://example.com/api/orgs/org-1/members/u-marcus/seat-cap', {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('/api/orgs/[orgId]/members/[userId]/seat-cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeOrgRequest).mockResolvedValue({ ok: true, userId: 'u-ana', role: 'ADMIN' });
  });

  it('WAL-7 (partial) an Admin\'s PUT reaches the service with the windows; DELETE clears', async () => {
    vi.mocked(setSeatCap).mockResolvedValue({ ok: true, walletId: 'w-pool', caps: [] });
    expect((await PUT(req('PUT', { monthlyCapCents: 2_000 }), ctx)).status).toBe(200);
    expect(authorizeOrgRequest).toHaveBeenCalledWith(expect.any(Request), 'org-1', 'ADMIN', expect.anything());
    expect(setSeatCap).toHaveBeenLastCalledWith('u-ana', 'org-1', 'u-marcus', { dailyCents: undefined, monthlyCents: 2_000 });
    await DELETE(req('DELETE'), ctx);
    expect(setSeatCap).toHaveBeenLastCalledWith('u-ana', 'org-1', 'u-marcus', null);
  });

  it('a caller the gate refuses never reaches the service', async () => {
    vi.mocked(authorizeOrgRequest).mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Insufficient organization role' }, { status: 403 }) });
    expect((await PUT(req('PUT', {}), ctx)).status).toBe(403);
    expect(setSeatCap).not.toHaveBeenCalled();
  });

  it('a refusal keeps the service\'s status and code', async () => {
    vi.mocked(setSeatCap).mockResolvedValue({ ok: false, status: 404, code: 'not_org_member', message: 'That person is not a member of this organization' });
    const res = await PUT(req('PUT', {}), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_org_member' });
  });
});
