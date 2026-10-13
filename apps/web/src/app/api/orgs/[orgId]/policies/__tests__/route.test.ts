/**
 * /api/orgs/[orgId]/policies (Spec POL-1, X-6). The store is faked; authorization is NOT: the real
 * requireOrgRole runs over a faked membership lookup, so a route that skipped it or asked for the wrong
 * role fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

// The org sign-in policy (SEC-2/3) has its own suites; here every credential meets it.
vi.mock('@pagespace/lib/permissions/actor-authentication', () => ({
  checkActorOrgAuthentication: vi.fn(async () => ({ allowed: true })),
  drivePolicyOrgId: vi.fn(async () => null),
}));
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policies', () => ({ getOrgPolicies: vi.fn(), updateOrgPolicies: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-suspension', () => ({ listPolicySuspensions: vi.fn() }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-suspension-names', () => ({ nameSuspensions: vi.fn(async (_orgId: string, _viewerId: string, listings: unknown) => listings) }));
vi.mock('@pagespace/lib/organizations/published-visibility', () => ({ reconcileOrgPublishedVisibility: vi.fn() }));
vi.mock('@/lib/canvas/published-storage', () => ({ createPublishedObjectStore: () => ({ store: true }), isPublishConfigured: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { getOrgPolicies, updateOrgPolicies } from '@pagespace/lib/organizations/policies';
import { listPolicySuspensions } from '@pagespace/lib/organizations/policy-suspension';
import { reconcileOrgPublishedVisibility } from '@pagespace/lib/organizations/published-visibility';
import { isPublishConfigured } from '@/lib/canvas/published-storage';
import { DEFAULT_ORG_POLICIES, MONEY_POLICY_KEYS, ORG_POLICY_MONEY } from '@pagespace/lib/organizations/policies-core';
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
  vi.mocked(isPublishConfigured).mockReturnValue(true);
  vi.mocked(reconcileOrgPublishedVisibility).mockResolvedValue([]);
  vi.mocked(listPolicySuspensions).mockResolvedValue([]);
  vi.mocked(updateOrgPolicies).mockResolvedValue({
    ok: true,
    policies: { ...DEFAULT_ORG_POLICIES, publicShareLinks: false },
    changes: [{ key: 'publicShareLinks', from: true, to: false }],
    suspended: [{ kind: 'publicShareLinks', resourceType: 'drive_share_link', id: 'l1', driveId: 'd1' }],
    restored: [],
    blocked: { counts: {}, total: 0, items: [] },
    signInBlocked: null,
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
    // Both reads are audited as data reads by the acting Admin, with the org as the dimension.
    expect(auditRequest).toHaveBeenCalledTimes(2);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', userId: 'user_priya', resourceId: ORG_ID, details: { orgId: ORG_ID } }));
  });

  it('X-4 (partial) a stored policy change is announced to the members of the org (org:changed, policy)', async () => {
    as('ADMIN');
    const { announceOrgChange } = await import('@pagespace/lib/organizations/org-change-events');
    expect((await PATCH(req('PATCH', '', { publicShareLinks: false }), ctx)).status).toBe(200);
    expect(announceOrgChange).toHaveBeenCalledWith(ORG_ID, 'policy');
  });

  it('POL-1 (partial) a change is stored for the acting Admin and reports what it suspended by count', async () => {
    as('ADMIN');
    const res = await PATCH(req('PATCH', '', { publicShareLinks: false }), ctx);
    expect(res.status).toBe(200);
    expect(updateOrgPolicies).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: 'user_priya', actorAuthentication: null, patch: { publicShareLinks: false } });
    expect(await res.json()).toMatchObject({ changed: ['publicShareLinks'], suspended: { publicShareLinks: 1 }, restored: {} });
  });

  it('POL-1 (partial) what a change blocks without suspending (apps, envs, agents, autonomy, models) is reported by count', async () => {
    as('ADMIN');
    vi.mocked(updateOrgPolicies).mockResolvedValue({
      ok: true,
      policies: { ...DEFAULT_ORG_POLICIES, publishedApps: false },
      changes: [{ key: 'publishedApps', from: true, to: false }],
      suspended: [],
      restored: [],
      blocked: { counts: { publishedApps: 2 }, total: 2, items: [] },
      signInBlocked: null,
    });
    expect(await (await PATCH(req('PATCH', '', { publishedApps: false }), ctx)).json()).toMatchObject({ blocked: { publishedApps: 2 } });
  });

  it('POL-6 (partial) raising the Open-drive floor while Open drives are below it is refused 403, naming the policy and the drives', async () => {
    as('ADMIN');
    vi.mocked(updateOrgPolicies).mockResolvedValue({ ok: false, reason: 'open_role_floor', floor: 'edit', drives: [{ id: 'd1', name: 'Product' }] });
    const res = await PATCH(req('PATCH', '', { openDriveRoleFloor: 'edit' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'org_policy', policy: 'openDriveRoleFloor', drives: [{ id: 'd1', name: 'Product' }] });
  });

  it('POL-1 (partial) unknown keys, bad values and empty bodies are refused before anything is stored', async () => {
    as('OWNER');
    for (const body of [{ nope: true }, { guests: 'maybe' }, {}, null]) {
      expect((await PATCH(req('PATCH', '', body), ctx)).status).toBe(400);
    }
    expect(updateOrgPolicies).not.toHaveBeenCalled();
  });

  it('POL-1 (partial) SEAT-9 (partial) a loosening change to a lapsed org gets the lapse refusal; nothing else runs', async () => {
    as('OWNER');
    vi.mocked(updateOrgPolicies).mockResolvedValue({ ok: false, reason: 'org_lapsed', message: 'Reactivate to continue.' });
    const res = await PATCH(req('PATCH', '', { guests: 'on' }), ctx);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'Reactivate to continue.', code: 'org_lapsed' });
    expect(reconcileOrgPublishedVisibility).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) the route does not pre-refuse a lapsed org: lib judges restricting vs loosening under the org lock ([D-OW-33])', async () => {
    as('ADMIN');
    const res = await PATCH(req('PATCH', '', { guests: 'off' }), ctx);
    expect(res.status).toBe(200);
    expect(updateOrgPolicies).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: 'user_priya', actorAuthentication: null, patch: { guests: 'off' } });
  });

  it('SEC-2 (partial) SEC-3 (partial) the acting credential\'s evidence reaches lib, where loosening a sign-in policy is judged (D-OW-45)', async () => {
    as('ADMIN');
    const authentication = { authenticatedAtMs: Date.now() - 1000, assurance: 'user_verified_passkey' as const };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ ...session('user_priya'), authentication });
    await PATCH(req('PATCH', '', { requireStrongSignIn: false }), ctx);
    expect(updateOrgPolicies).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: 'user_priya', actorAuthentication: authentication, patch: { requireStrongSignIn: false } });
  });

  it.each(['org_strong_sign_in_required', 'org_reauthentication_required'] as const)(
    'SEC-2 (partial) SEC-3 (partial) a sign-in loosening refused for the credential answers 403 with the actionable code %s',
    async (code) => {
      as('OWNER');
      vi.mocked(updateOrgPolicies).mockResolvedValue({ ok: false, reason: code });
      const res = await PATCH(req('PATCH', '', { requireStrongSignIn: false }), ctx);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code, orgId: ORG_ID });
      expect(reconcileOrgPublishedVisibility).not.toHaveBeenCalled();
    },
  );

  it('SEC-2 (partial) tightening a sign-in policy the acting Admin would not meet answers 403 naming what would (D-OW-47)', async () => {
    as('ADMIN');
    vi.mocked(updateOrgPolicies).mockResolvedValue({ ok: false, reason: 'org_policy_would_lock_out_actor', requires: 'org_strong_sign_in_required' });
    const res = await PATCH(req('PATCH', '', { requireStrongSignIn: true }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'org_policy_would_lock_out_actor', requires: 'org_strong_sign_in_required', orgId: ORG_ID });
  });

  it('POL-1 (partial) who a tightened sign-in policy now refuses is reported by count', async () => {
    as('ADMIN');
    vi.mocked(updateOrgPolicies).mockResolvedValue({
      ok: true, policies: { ...DEFAULT_ORG_POLICIES, requireStrongSignIn: true }, changes: [{ key: 'requireStrongSignIn', from: false, to: true }],
      suspended: [], restored: [], blocked: { counts: {}, total: 0, items: [] }, signInBlocked: { members: 3, guests: 1, credentials: 5 },
    });
    expect(await (await PATCH(req('PATCH', '', { requireStrongSignIn: true }), ctx)).json()).toMatchObject({ signInBlocked: { members: 3, guests: 1, credentials: 5 } });
  });

  it('POL-1 (partial) the routes are dark with the orgs flag off', async () => {
    flags.orgsEnabled = false;
    as('OWNER');
    expect((await GET(req('GET'), ctx)).status).toBe(404);
    expect((await PATCH(req('PATCH', '', { guests: 'off' }), ctx)).status).toBe(404);
  });
  describe('published sites follow the publishing policies', () => {
    const changedPublishing = () =>
      vi.mocked(updateOrgPolicies).mockResolvedValue({
        ok: true,
        policies: { ...DEFAULT_ORG_POLICIES, publishWeb: false },
        changes: [{ key: 'publishWeb', from: true, to: false }],
        suspended: [],
        restored: [],
        blocked: { counts: {}, total: 0, items: [] },
        signInBlocked: null,
      });

    it('POL-4 (partial) a change to publishing moves the org\'s sites in the bucket right away and reports what moved', async () => {
      as('ADMIN');
      changedPublishing();
      vi.mocked(reconcileOrgPublishedVisibility).mockResolvedValue([
        { prefix: 'a', action: 'parked', objects: 3 },
        { prefix: 'b', action: 'parked', objects: 1 },
        { prefix: 'c', action: 'failed', objects: 0 },
      ]);
      const res = await PATCH(req('PATCH', '', { publishWeb: false }), ctx);
      expect(reconcileOrgPublishedVisibility).toHaveBeenCalledWith(ORG_ID, { store: true });
      expect((await res.json()).publishedVisibility).toEqual({ parked: 2, restored: 0, failed: 1 });
    });

    it('POL-4 (partial) a change to an unrelated policy never touches the bucket', async () => {
      as('ADMIN');
      await PATCH(req('PATCH', '', { publicShareLinks: false }), ctx);
      expect(reconcileOrgPublishedVisibility).not.toHaveBeenCalled();
    });

    it('POL-4 (partial) a bucket failure never undoes the policy: still 200, reported, left for the sweep', async () => {
      as('ADMIN');
      changedPublishing();
      vi.mocked(reconcileOrgPublishedVisibility).mockRejectedValue(new Error('bucket down'));
      const res = await PATCH(req('PATCH', '', { publishWeb: false }), ctx);
      expect(res.status).toBe(200);
      expect((await res.json()).publishedVisibility).toEqual({ parked: 0, restored: 0, failed: -1 });
    });

    it('POL-4 (partial) with no publish bucket configured there is nothing to move', async () => {
      as('ADMIN');
      changedPublishing();
      vi.mocked(isPublishConfigured).mockReturnValue(false);
      await PATCH(req('PATCH', '', { publishWeb: false }), ctx);
      expect(reconcileOrgPublishedVisibility).not.toHaveBeenCalled();
    });
  });
});

describe('money policy keys and delegated keys ([D-OW-26], D-OW-47)', () => {
  const key = (): MCPAuthResult => ({ userId: 'user_priya', tokenVersion: 0, tokenType: 'mcp', tokenId: 'tok', role: 'user', adminRoleVersion: 0, allowedDriveIds: [] });

  it.each(MONEY_POLICY_KEYS.map((k) => [k] as const))('X-1 (partial) an Admin key setting %s is refused by name and nothing is stored', async (moneyKey) => {
    as('ADMIN');
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(key());
    const res = await PATCH(req('PATCH', '', { publishWeb: false, [moneyKey]: DEFAULT_ORG_POLICIES[moneyKey] }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(ORG_POLICY_MONEY[moneyKey] === 'moves_money' ? 'mcp_token_cannot_move_money' : 'mcp_token_cannot_change_spend_source');
    expect(updateOrgPolicies).not.toHaveBeenCalled();
  });

  it('X-1 (partial) a key changes non-money policies and reads them back without any money key; a session reads and sets them all', async () => {
    as('ADMIN');
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(key());
    const patched = await PATCH(req('PATCH', '', { publicShareLinks: false }), ctx);
    expect(patched.status).toBe(200);
    const read = await (await GET(req('GET'), ctx)).json();
    const written = await patched.json();
    for (const moneyKey of MONEY_POLICY_KEYS) {
      expect(read.policies).not.toHaveProperty(moneyKey);
      expect(written.policies).not.toHaveProperty(moneyKey);
    }

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
    expect((await (await GET(req('GET'), ctx)).json()).policies).toEqual(DEFAULT_ORG_POLICIES);
    expect((await PATCH(req('PATCH', '', { seatAllowanceCents: 5000, walletFallback: 'own_credits' }), ctx)).status).toBe(200);
  });
});
