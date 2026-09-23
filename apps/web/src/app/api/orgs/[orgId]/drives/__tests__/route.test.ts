/**
 * GET /api/orgs/[orgId]/drives — the org Drives directory (Spec DRV-6). Authorization is NOT faked:
 * the real requireOrgRole runs over a faked membership lookup, so a route that skipped the org gate
 * fails here. The directory query itself is tested against real Postgres in packages/lib.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/permissions/org-drive-directory', () => ({ listOrgDriveDirectory: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { listOrgDriveDirectory } from '@pagespace/lib/permissions/org-drive-directory';
import { GET } from '../route';

const ORG = 'org-northwind';
const LENA = 'user-lena';
const context = { params: Promise.resolve({ orgId: ORG }) };
const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 'session-1', role: 'user', adminRoleVersion: 0,
});
const get = () => new Request(`https://example.com/api/orgs/${ORG}/drives`);

const research = {
  id: 'drive-research', name: 'Research', slug: 'research', orgVisibility: 'RESTRICTED',
  joined: false, joinRequest: null, canRequest: true, lead: { id: 'user-marcus', name: 'Marcus', image: null },
};

describe('GET /api/orgs/[orgId]/drives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.orgsEnabled = true;
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(LENA));
  });

  it('DRV-6 (partial) an org member gets the directory for themselves, and the read is audited', async () => {
    vi.mocked(findMembershipRole).mockResolvedValue('MEMBER');
    vi.mocked(listOrgDriveDirectory).mockResolvedValue([research as never]);

    const response = await GET(get(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drives: [research] });
    expect(listOrgDriveDirectory).toHaveBeenCalledWith(ORG, LENA);
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
      eventType: 'data.read', userId: LENA, resourceType: 'organization_drives', resourceId: ORG,
    }));
  });

  it('DRV-6 (partial) a non-member sees no directory: 404, and the query never runs', async () => {
    vi.mocked(findMembershipRole).mockResolvedValue(null);

    const response = await GET(get(), context);

    expect(response.status).toBe(404);
    expect(listOrgDriveDirectory).not.toHaveBeenCalled();
  });

  it('answers 404 without authenticating while ORGS_ENABLED is false', async () => {
    flags.orgsEnabled = false;

    expect((await GET(get(), context)).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
  });
});
