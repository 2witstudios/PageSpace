import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../organizations/policy-reader', () => ({
  getDriveAuthenticationPolicies: vi.fn(),
  getResourceDriveIds: vi.fn(),
  getDerivedPageOrgIds: vi.fn(),
  getOrgPolicies: vi.fn(),
  listOrgIdsOfDrives: vi.fn(),
}));

import { getDerivedPageOrgIds, getDriveAuthenticationPolicies, getOrgPolicies, getResourceDriveIds } from '../../organizations/policy-reader';
import { parseOrgPolicies } from '../../organizations/policies-core';
import { HELD_DRIVES, automationActor, credentialActor, inDrives } from '../access-actor';
import {
  checkActorDriveAuthentication,
  checkActorOrgAuthentication,
  checkActorResourceAuthentication,
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
  vi.mocked(getDerivedPageOrgIds).mockReset();
  vi.mocked(getOrgPolicies).mockReset();
  // A memory page in the personal (Home) drive restates content distilled from org-a's drives.
  vi.mocked(getDerivedPageOrgIds).mockImplementation(async (ids) =>
    new Map(ids.filter((id) => id === MEMORY_PAGE).map((id) => [id, ['org-a']])));
  vi.mocked(getOrgPolicies).mockImplementation(async () => parseOrgPolicies(maxAgeHour));
});

const MEMORY_PAGE = 'page-memory-bio';

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

  it('SEC-2 (partial) an automation is admitted inside its scope without reading any policy, and refused outside it', async () => {
    const actor = automationActor('user-1', 'workflow', inDrives(ORG_DRIVE));
    expect(await checkActorDriveAuthentication(actor, PERSONAL_DRIVE)).toEqual({ allowed: false, code: 'automation_out_of_scope' });
    expect([...(await filterDrivesForActor(actor, [ORG_DRIVE, PERSONAL_DRIVE]))]).toEqual([ORG_DRIVE]);
    expect(await checkActorDriveAuthentication(actor, ORG_DRIVE)).toEqual({ allowed: true });
    expect([...(await filterDrivesForActor(actor, [ORG_DRIVE]))]).toEqual([ORG_DRIVE]);
    expect(getDriveAuthenticationPolicies).not.toHaveBeenCalled();
    expect(getResourceDriveIds).not.toHaveBeenCalled();
  });
});

describe('pages that restate org-derived content (memory pages, D-OW-62)', () => {
  const stale = () => credentialActor('user-1', { authenticatedAtMs: Date.now() - 2 * HOUR, assurance: 'single_factor' });
  const fresh = () => credentialActor('user-1', { authenticatedAtMs: Date.now() - 60_000, assurance: 'single_factor' });

  it('SEC-3 (partial) a memory page in a personal drive is withheld from a credential a contributing org refuses, with its code', async () => {
    expect(await checkActorResourceAuthentication(stale(), MEMORY_PAGE)).toEqual({ allowed: false, code: 'org_reauthentication_required' });
    expect(await explainOrgAuthenticationDenial(stale(), MEMORY_PAGE)).toBe('org_reauthentication_required');
    expect([...(await filterResourcesForActor(stale(), [MEMORY_PAGE, 'page-mine']))]).toEqual(['page-mine']);
  });

  it('SEC-3 (partial) a credential every contributing org admits reads the memory page', async () => {
    expect(await checkActorResourceAuthentication(fresh(), MEMORY_PAGE)).toEqual({ allowed: true });
    expect([...(await filterResourcesForActor(fresh(), [MEMORY_PAGE, 'page-mine']))]).toEqual([MEMORY_PAGE, 'page-mine']);
  });

  it('SEC-2 (partial) an automation is judged by its scope alone, and ordinary pages read no org policy', async () => {
    const held = automationActor('user-1', 'memory-discovery', HELD_DRIVES);
    expect(await checkActorResourceAuthentication(held, MEMORY_PAGE)).toEqual({ allowed: true });
    expect(await checkActorResourceAuthentication(stale(), 'page-mine')).toEqual({ allowed: true });
    expect(getOrgPolicies).not.toHaveBeenCalled();
  });
});

describe('the org\'s own sign-in policy (checkActorOrgAuthentication)', () => {
  it('SEC-3 (partial) a credential older than the org\'s maximum age is refused acting on the org; a fresh one is admitted', async () => {
    const stale = credentialActor('user-1', { authenticatedAtMs: Date.now() - 2 * HOUR, assurance: 'single_factor' });
    const fresh = credentialActor('user-1', { authenticatedAtMs: Date.now() - 1000, assurance: 'single_factor' });
    expect(await checkActorOrgAuthentication(stale, 'org-a')).toEqual({ allowed: false, code: 'org_reauthentication_required' });
    expect(await checkActorOrgAuthentication(fresh, 'org-a')).toEqual({ allowed: true });
  });

  it('D-OW-53(3) a damaged stored maximum age is held to the 15-minute floor, so a freshly signed-in Admin can repair it', async () => {
    vi.mocked(getOrgPolicies).mockResolvedValue({ ...parseOrgPolicies({}), maximumSessionAgeMinutes: 0 });
    const fresh = credentialActor('user-1', { authenticatedAtMs: Date.now() - 60_000, assurance: 'single_factor' });
    const twentyMinutes = credentialActor('user-1', { authenticatedAtMs: Date.now() - 20 * 60_000, assurance: 'single_factor' });
    expect(await checkActorOrgAuthentication(fresh, 'org-a')).toEqual({ allowed: true });
    expect(await checkActorOrgAuthentication(twentyMinutes, 'org-a')).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });

  it('an automation never reaches org admin routes, so sign-in policy never applies to it and nothing is read', async () => {
    expect(await checkActorOrgAuthentication(automationActor('user-1', 'workflow', inDrives('drive-1')), 'org-a')).toEqual({ allowed: true });
    expect(getOrgPolicies).not.toHaveBeenCalled();
  });
});
