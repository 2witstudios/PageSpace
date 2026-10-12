import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../organizations/policy-reader', () => ({
  getDriveAuthenticationPolicies: vi.fn(),
  getResourceDriveIds: vi.fn(),
}));

import { getDriveAuthenticationPolicies, getResourceDriveIds } from '../../organizations/policy-reader';
import { automationActor, credentialActor } from '../access-actor';
import {
  checkActorDriveAuthentication,
  explainOrgAuthenticationDenial,
  filterDrivesForActor,
  filterResourcesForActor,
} from '../actor-authentication';

const HOUR = 60 * 60_000;
const ORG_DRIVE = 'drive-org';
const PERSONAL_DRIVE = 'drive-personal';
const maxAgeHour = { requireStrongSignIn: false, maximumSessionAgeMinutes: 60 };

beforeEach(() => {
  vi.mocked(getDriveAuthenticationPolicies).mockReset();
  vi.mocked(getResourceDriveIds).mockReset();
  vi.mocked(getDriveAuthenticationPolicies).mockImplementation(async (ids) =>
    new Map(ids.map((id) => [id, id === ORG_DRIVE ? maxAgeHour : null])));
  vi.mocked(getResourceDriveIds).mockImplementation(async (ids) =>
    new Map(ids.map((id) => [id, id.startsWith('page-org') ? ORG_DRIVE : id.startsWith('page-') ? PERSONAL_DRIVE : id])));
});

describe('the actor sign-in shell', () => {
  it('SEC-3 (partial) explainOrgAuthenticationDenial names the reauthentication code for a stale credential', async () => {
    const stale = credentialActor('user-1', { authenticatedAtMs: Date.now() - 2 * HOUR, assurance: 'single_factor' });
    expect(await explainOrgAuthenticationDenial(stale, 'page-org-1')).toBe('org_reauthentication_required');
    expect(await explainOrgAuthenticationDenial(stale, ORG_DRIVE)).toBe('org_reauthentication_required');
  });

  it('SEC-3 (partial) a fresh credential, and any credential on a personal drive, has no denial to explain', async () => {
    const fresh = credentialActor('user-1', { authenticatedAtMs: Date.now() - 60_000, assurance: 'single_factor' });
    const stale = credentialActor('user-1', { authenticatedAtMs: Date.now() - 2 * HOUR, assurance: 'single_factor' });
    expect(await explainOrgAuthenticationDenial(fresh, 'page-org-1')).toBeNull();
    expect(await explainOrgAuthenticationDenial(stale, 'page-mine')).toBeNull();
  });

  it('SEC-3 (partial) batch filters drop exactly the refused org drive and its pages', async () => {
    const stale = credentialActor('user-1', { authenticatedAtMs: Date.now() - 2 * HOUR, assurance: 'single_factor' });
    expect([...(await filterDrivesForActor(stale, [ORG_DRIVE, PERSONAL_DRIVE]))]).toEqual([PERSONAL_DRIVE]);
    expect([...(await filterResourcesForActor(stale, ['page-org-1', 'page-mine']))]).toEqual(['page-mine']);
  });

  it('SEC-2 (partial) an automation is admitted without reading any policy', async () => {
    const actor = automationActor('user-1', 'workflow');
    expect(await checkActorDriveAuthentication(actor, ORG_DRIVE)).toEqual({ allowed: true });
    expect([...(await filterDrivesForActor(actor, [ORG_DRIVE]))]).toEqual([ORG_DRIVE]);
    expect(getDriveAuthenticationPolicies).not.toHaveBeenCalled();
    expect(getResourceDriveIds).not.toHaveBeenCalled();
  });
});
