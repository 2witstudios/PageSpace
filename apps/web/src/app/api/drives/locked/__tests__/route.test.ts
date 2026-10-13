import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: (r: object) => 'error' in r }));
vi.mock('@pagespace/lib/services/drive-service', () => ({ listAccessibleDrives: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-reader', () => ({ getOrgPolicies: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findOrganizationNames: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { findOrganizationNames } from '@pagespace/lib/organizations/repository';
import { GET } from '../route';

const req = () => new Request('https://example.test/api/drives/locked');
const asSession = (authentication: unknown) =>
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ tokenType: 'session', userId: 'u1', sessionId: 's', authentication } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAccessibleDrives).mockResolvedValue([
    { id: 'd_org', name: 'Roadmap', orgId: 'org_nw' },
    { id: 'd_home', name: 'Home', orgId: null },
  ] as never);
  vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES, requireStrongSignIn: true });
  vi.mocked(findOrganizationNames).mockResolvedValue(new Map([['org_nw', 'Northwind']]));
});

describe('GET /api/drives/locked (D-OW-45)', () => {
  it('SEC-2 (partial) an org drive the session is locked out of is listed with its org and the code that unlocks it', async () => {
    asSession({ authenticatedAtMs: Date.now() - 1000, assurance: 'single_factor' });
    const res = await GET(req());
    expect(await res.json()).toEqual({
      locked: [{ driveId: 'd_org', driveName: 'Roadmap', orgId: 'org_nw', orgName: 'Northwind', code: 'org_strong_sign_in_required' }],
    });
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: false });
  });

  it('SEC-2 (partial) a credential that satisfies the policy has nothing locked', async () => {
    asSession({ authenticatedAtMs: Date.now() - 1000, assurance: 'user_verified_passkey' });
    expect(await (await GET(req())).json()).toEqual({ locked: [] });
    expect(findOrganizationNames).not.toHaveBeenCalled();
  });

  it('SEC-3 (partial) a credential minted before evidence existed is locked under any sign-in policy (no backfill)', async () => {
    vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES, maximumSessionAgeMinutes: 60 });
    asSession(undefined);
    expect(await (await GET(req())).json()).toMatchObject({ locked: [{ driveId: 'd_org', code: 'org_reauthentication_required' }] });
  });
});
