/**
 * HTTP surface of the org pool's kill switch (Spec WAL-7). The service's decision is proven against
 * Postgres (wallet-gate.integration "WAL-7 …"); this pins the route's wiring: the org gate runs first at
 * ADMIN with the session-only write auth, the body maps to the service, and refusals keep its status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({ getOrgPoolSplit: vi.fn(), setOrgPoolPaused: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));
vi.mock('@/lib/orgs/org-route-auth', () => ({
  authorizeOrgRequest: vi.fn(),
  ORG_READ_AUTH: { allow: ['session'], requireCSRF: false },
  ORG_SESSION_WRITE_AUTH: { allow: ['session'], requireCSRF: true },
}));

import { PATCH } from '../route';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { setOrgPoolPaused } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest, ORG_SESSION_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

const ctx = { params: Promise.resolve({ orgId: 'org-1' }) };
const req = (body: unknown) => new Request('https://example.com/api/orgs/org-1/pool', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('PATCH /api/orgs/[orgId]/pool — the pool kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeOrgRequest).mockResolvedValue({ ok: true, userId: 'u-ana', role: 'ADMIN', allowedDriveIds: [], authentication: null, actor: credentialActor('u-ana', null), credential: 'session' });
  });

  it('WAL-7 (partial) an Admin pauses and resumes the pool through the service, behind the session-only Admin gate', async () => {
    vi.mocked(setOrgPoolPaused).mockResolvedValue({ ok: true, walletId: 'w-pool', status: 'paused' });
    const res = await PATCH(req({ paused: true }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ walletId: 'w-pool', status: 'paused' });
    expect(authorizeOrgRequest).toHaveBeenCalledWith(expect.any(Request), 'org-1', 'ADMIN', ORG_SESSION_WRITE_AUTH);
    expect(setOrgPoolPaused).toHaveBeenLastCalledWith('u-ana', 'org-1', true);
    vi.mocked(setOrgPoolPaused).mockResolvedValue({ ok: true, walletId: 'w-pool', status: 'active' });
    await PATCH(req({ paused: false }), ctx);
    expect(setOrgPoolPaused).toHaveBeenLastCalledWith('u-ana', 'org-1', false);
  });

  it('a caller the gate refuses never reaches the service', async () => {
    vi.mocked(authorizeOrgRequest).mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Insufficient organization role' }, { status: 403 }) });
    expect((await PATCH(req({ paused: true }), ctx)).status).toBe(403);
    expect(setOrgPoolPaused).not.toHaveBeenCalled();
  });

  it('a body without a boolean `paused` is refused before the service', async () => {
    expect((await PATCH(req({ paused: 'yes' }), ctx)).status).toBe(400);
    expect((await PATCH(req({ paused: true, extra: 1 }), ctx)).status).toBe(400);
    expect(setOrgPoolPaused).not.toHaveBeenCalled();
  });

  it('a refusal (a lapsed org resuming, no pool yet) keeps the service\'s status and code', async () => {
    vi.mocked(setOrgPoolPaused).mockResolvedValue({ ok: false, status: 402, code: 'org_lapsed', message: 'lapsed' });
    const res = await PATCH(req({ paused: false }), ctx);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'org_lapsed' });
  });
});
