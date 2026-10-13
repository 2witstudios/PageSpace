/**
 * GET /api/orgs/[orgId]/policies/sign-in-preview (D-OW-45, UI-7). Authorization is real (requireOrgRole over a faked
 * membership lookup); the count is faked — its rule and SQL are proven in lib.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/organizations/sign-in-blocked', () => ({ countOrgSignInBlocked: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: { fake: true } }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { countOrgSignInBlocked } from '@pagespace/lib/organizations/sign-in-blocked';
import { GET } from '../route';

const ctx = { params: Promise.resolve({ orgId: 'org_nw' }) };
const req = (query: string) => new Request(`https://example.test/api/orgs/org_nw/policies/sign-in-preview${query}`);
const session: SessionAuthResult = { userId: 'u', tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 };
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
  vi.mocked(countOrgSignInBlocked).mockResolvedValue({ members: 4, guests: 2, credentials: 9 });
});

describe('sign-in policy preview', () => {
  it('SEC-2 (partial) SEC-3 (partial) an Admin sees how many members the policy would refuse, as counts only', async () => {
    as('ADMIN');
    const res = await GET(req('?requireStrongSignIn=true&maximumSessionAgeMinutes=60'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: 4, guests: 2, credentials: 9 });
    expect(countOrgSignInBlocked).toHaveBeenCalledWith({ fake: true }, 'org_nw', { requireStrongSignIn: true, maximumSessionAgeMinutes: 60 });
  });

  it('no maximum age is previewed as none', async () => {
    as('OWNER');
    await GET(req('?requireStrongSignIn=false'), ctx);
    expect(countOrgSignInBlocked).toHaveBeenCalledWith({ fake: true }, 'org_nw', { requireStrongSignIn: false, maximumSessionAgeMinutes: null });
  });

  it('UI-11 (partial) a plain member is refused and a non-member sees no org', async () => {
    as('MEMBER');
    expect((await GET(req(''), ctx)).status).toBe(403);
    as(null);
    expect((await GET(req(''), ctx)).status).toBe(404);
    expect(countOrgSignInBlocked).not.toHaveBeenCalled();
  });

  it.each(['?maximumSessionAgeMinutes=14', '?maximumSessionAgeMinutes=43201', '?maximumSessionAgeMinutes=1.5', '?requireStrongSignIn=yes'])(
    'a value outside the allowed range is refused (%s)',
    async (query) => {
      as('ADMIN');
      const res = await GET(req(query), ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    },
  );
});
