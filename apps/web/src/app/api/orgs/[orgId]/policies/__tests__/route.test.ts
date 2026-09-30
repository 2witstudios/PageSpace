/**
 * /api/orgs/[orgId]/policies (Spec POL-1, X-6). The store is faked; authorization is NOT: the real
 * requireOrgRole runs over a faked membership lookup, so a route that skipped it or asked for the wrong
 * role fails here.
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
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policies', () => ({ getOrgPolicies: vi.fn(), updateOrgPolicies: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-suspension', () => ({ listPolicySuspensions: vi.fn() }));
vi.mock('@pagespace/lib/organizations/status', () => ({ checkOrgActive: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { getOrgPolicies, updateOrgPolicies } from '@pagespace/lib/organizations/policies';
import { listPolicySuspensions } from '@pagespace/lib/organizations/policy-suspension';
import { checkOrgActive } from '@pagespace/lib/organizations/status';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { GET, PATCH } from '../route';
import { GET as GET_SUSPENDED } from '../suspended/route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const req = (method: string, path = '', body?: unknown) =>
  new Request(`https://example.test/api/orgs/${ORG_ID}/policies${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES });
  vi.mocked(checkOrgActive).mockResolvedValue({ ok: true });
  vi.mocked(listPolicySuspensions).mockResolvedValue([]);
  vi.mocked(updateOrgPolicies).mockResolvedValue({
    ok: true,
    policies: { ...DEFAULT_ORG_POLICIES, publicShareLinks: false },
    changes: [{ key: 'publicShareLinks', from: true, to: false }],
    suspended: [{ kind: 'publicShareLinks', resourceType: 'drive_share_link', id: 'l1', driveId: 'd1' }],
    restored: [],
    auditRecorded: true,
  });
});

describe('policies routes', () => {
  it('POL-1 (partial) X-6 (partial) only Owner and Admins read or change policies; a plain member is refused and a non-member sees no org', async () => {
    as('MEMBER');
    expect((await GET(req('GET'), ctx)).status).toBe(403);
    expect((await PATCH(req('PATCH', '', { guests: 'off' }), ctx)).status).toBe(403);
    expect((await GET_SUSPENDED(req('GET', '/suspended'), ctx)).status).toBe(403);
    as(null);
    expect((await GET(req('GET'), ctx)).status).toBe(404);
    expect((await PATCH(req('PATCH', '', { guests: 'off' }), ctx)).status).toBe(404);
    expect((await GET_SUSPENDED(req('GET', '/suspended'), ctx)).status).toBe(404);
    expect(updateOrgPolicies).not.toHaveBeenCalled();
    expect(getOrgPolicies).not.toHaveBeenCalled();
    expect(listPolicySuspensions).not.toHaveBeenCalled();
  });

  it('POL-1 (partial) an Admin reads the policies and lists what is suspended', async () => {
    as('ADMIN');
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).policies).toEqual(DEFAULT_ORG_POLICIES);
    expect((await GET_SUSPENDED(req('GET', '/suspended'), ctx)).status).toBe(200);
  });

  it('POL-1 (partial) a change is stored for the acting Admin and reports what it suspended by count', async () => {
    as('ADMIN');
    const res = await PATCH(req('PATCH', '', { publicShareLinks: false }), ctx);
    expect(res.status).toBe(200);
    expect(updateOrgPolicies).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: 'user_priya', patch: { publicShareLinks: false } });
    expect(await res.json()).toMatchObject({ changed: ['publicShareLinks'], suspended: { publicShareLinks: 1 }, restored: {}, auditRecorded: true });
  });

  it('POL-1 (partial) unknown keys, bad values and empty bodies are refused before anything is stored', async () => {
    as('OWNER');
    for (const body of [{ nope: true }, { guests: 'maybe' }, {}, null]) {
      expect((await PATCH(req('PATCH', '', body), ctx)).status).toBe(400);
    }
    expect(updateOrgPolicies).not.toHaveBeenCalled();
  });

  it('POL-1 (partial) SEAT-9 (partial) a lapsed org cannot change policies', async () => {
    as('OWNER');
    vi.mocked(checkOrgActive).mockResolvedValue({ ok: false, code: 'org_lapsed', status: 402, message: 'lapsed' });
    const res = await PATCH(req('PATCH', '', { guests: 'off' }), ctx);
    expect(res.status).toBe(402);
    expect(updateOrgPolicies).not.toHaveBeenCalled();
  });

  it('POL-1 (partial) a change that committed but was not audited is reported, not hidden', async () => {
    as('OWNER');
    vi.mocked(updateOrgPolicies).mockResolvedValue({ ok: true, policies: { ...DEFAULT_ORG_POLICIES }, changes: [], suspended: [], restored: [], auditRecorded: false });
    expect((await (await PATCH(req('PATCH', '', { guests: 'on' }), ctx)).json()).auditRecorded).toBe(false);
  });

  it('POL-1 (partial) the routes are dark with the orgs flag off', async () => {
    flags.orgsEnabled = false;
    as('OWNER');
    expect((await GET(req('GET'), ctx)).status).toBe(404);
    expect((await PATCH(req('PATCH', '', { guests: 'off' }), ctx)).status).toBe(404);
  });
});
