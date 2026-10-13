import { describe, it, expect, vi, beforeEach } from 'vitest';

// D-OW-45: the org sign-in decision, refused here for every org drive; the personal drive passes.
const ORG_DRIVE = 'drive-org';
const PERSONAL_DRIVE = 'drive-personal';
vi.mock('../actor-authentication', () => ({
  checkActorDriveAuthentication: vi.fn(async () => ({ allowed: false, code: 'org_reauthentication_required' })),
  checkActorResourceAuthentication: vi.fn(async () => ({ allowed: false, code: 'org_reauthentication_required' })),
  filterDrivesForActor: vi.fn(async (_actor: unknown, ids: readonly string[]) => new Set(ids.filter((id) => id !== 'drive-org'))),
  filterResourcesForActor: vi.fn(async () => new Set<string>()),
  explainOrgAuthenticationDenial: vi.fn(async () => 'org_reauthentication_required'),
}));
vi.mock('../org-drive-membership', () => ({
  loadEffectiveDriveMembership: vi.fn(),
  loadOrgRolesForUser: vi.fn(),
  resolveEffectiveDriveMemberships: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));

import { db } from '@pagespace/db/db';
import { loadEffectiveDriveMembership } from '../org-drive-membership';
import { credentialActor } from '../access-actor';
import {
  canUserDeletePage,
  canUserEditPage,
  canUserSharePage,
  canUserViewPage,
  getBatchPagePermissions,
  getDriveIdsForUser,
  getUserAccessLevel,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
  getUserDriveAccess,
  getUserDrivePermissions,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
} from '../permissions';

const stale = credentialActor('user-1', { authenticatedAtMs: 0, assurance: 'single_factor' });
const PAGE = 'pageaaaaaaaaaaaaaaaaaaaa1';

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(loadEffectiveDriveMembership).mockReset();
});

describe('the actor access API behind the org sign-in decision', () => {
  it('SEC-2 (partial) every actor access function refuses a credential its org\'s sign-in policy refuses, exactly like no access', async () => {
    expect(await getUserAccessLevel(stale, PAGE)).toBeNull();
    expect(await canUserViewPage(stale, PAGE)).toBe(false);
    expect(await canUserEditPage(stale, PAGE)).toBe(false);
    expect(await canUserSharePage(stale, PAGE)).toBe(false);
    expect(await canUserDeletePage(stale, PAGE)).toBe(false);
    expect(await isDriveOwnerOrAdmin(stale, ORG_DRIVE)).toBe(false);
    expect(await isUserDriveMember(stale, ORG_DRIVE)).toBe(false);
    expect(await getUserDriveAccess(stale, ORG_DRIVE)).toBe(false);
    expect(await getUserDrivePermissions(stale, ORG_DRIVE)).toBeNull();
    expect(await getUserAccessiblePagesInDrive(stale, ORG_DRIVE)).toEqual([]);
    expect(await getUserAccessiblePagesInDriveWithDetails(stale, ORG_DRIVE)).toEqual([]);
    const batch = await getBatchPagePermissions(stale, [PAGE]);
    expect(batch.get(PAGE)).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
  });

  it('SEC-2 (partial) a refused credential never reaches the userId resolver: no page, drive or membership read', async () => {
    await getUserAccessLevel(stale, PAGE);
    await isDriveOwnerOrAdmin(stale, ORG_DRIVE);
    await isUserDriveMember(stale, ORG_DRIVE);
    await getUserDriveAccess(stale, ORG_DRIVE);
    await getUserDrivePermissions(stale, ORG_DRIVE);
    await getUserAccessiblePagesInDrive(stale, ORG_DRIVE);
    await getUserAccessiblePagesInDriveWithDetails(stale, ORG_DRIVE);
    await getBatchPagePermissions(stale, [PAGE]);
    expect(db.select).not.toHaveBeenCalled();
    expect(loadEffectiveDriveMembership).not.toHaveBeenCalled();
  });

  it('SEC-2 (partial) the drive list keeps personal drives and drops the org drive the credential is refused', async () => {
    let call = 0;
    const rowsFor = () => (call++ === 0 ? [{ id: ORG_DRIVE }, { id: PERSONAL_DRIVE }] : []);
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => Promise.resolve(rowsFor()),
    };
    vi.mocked(db.select).mockImplementation((() => chain) as never);
    expect(await getDriveIdsForUser(stale)).toEqual([PERSONAL_DRIVE]);
  });
});
