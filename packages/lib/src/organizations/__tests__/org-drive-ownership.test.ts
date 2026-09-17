import { describe, it, expect } from 'vitest';
import {
  decideMoveDriveIntoOrg,
  decideMoveDriveOutOfOrg,
  decideCreateDriveInOrg,
  canLeadOrgDrive,
  orgDriveVisibilityForInsert,
  STORAGE_REATTRIBUTION_LEAF_ID,
  ORG_DRIVE_CREATION_POLICY_LEAF_ID,
  ORG_DRIVE_SLUG_CONSTRAINT,
  ORG_SLUG_ATTEMPTS,
  retryOnOrgSlugConflict,
  type MoveInDrive,
} from '../org-drive-ownership';

// Northwind Labs fixture (Sequence Spec Part 2): Jono owns the org, Priya is an admin,
// Marcus a member, Chris Rowe a guest (no org role).
const JONO = 'user-jono';
const MARCUS = 'user-marcus';
const NORTHWIND = 'org-northwind';

const personalProduct = (overrides: Partial<MoveInDrive> = {}): MoveInDrive => ({
  kind: 'STANDARD',
  ownerId: MARCUS,
  orgId: null,
  isTrashed: false,
  ...overrides,
});

describe('decideMoveDriveIntoOrg', () => {
  it('DRV-2 (partial) the drive owner who is an org member may move their drive in', () => {
    expect(
      decideMoveDriveIntoOrg({ drive: personalProduct(), actorId: MARCUS, actorOrgRole: 'MEMBER' })
    ).toEqual({ ok: true });
  });

  it('DRV-1 (partial) a Home drive can never move into an org, with the drive-guards message', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct({ kind: 'HOME' }),
      actorId: MARCUS,
      actorOrgRole: 'OWNER',
    });
    expect(verdict).toEqual({
      ok: false,
      code: 'HOME_DRIVE',
      status: 403,
      message: 'Your Home drive is your own space and cannot be moved into an organization.',
    });
  });

  it('DRV-2 (partial) an org Admin who does not own the drive cannot move it in', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct(),
      actorId: JONO,
      actorOrgRole: 'OWNER',
    });
    expect(verdict).toMatchObject({ ok: false, code: 'NOT_DRIVE_OWNER', status: 403 });
  });

  it('D-OW-7 a drive owner outside the org cannot move in, because the lead must be an org member', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct(),
      actorId: MARCUS,
      actorOrgRole: null,
    });
    expect(verdict).toMatchObject({ ok: false, code: 'NOT_ORG_MEMBER', status: 403 });
  });

  it('DRV-2 (partial) a drive already owned by an org cannot be moved in again', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct({ orgId: 'org-other' }),
      actorId: MARCUS,
      actorOrgRole: 'MEMBER',
    });
    expect(verdict).toMatchObject({ ok: false, code: 'ALREADY_IN_ORG', status: 409 });
  });

  it('DRV-2 (partial) a trashed drive cannot be moved in', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct({ isTrashed: true }),
      actorId: MARCUS,
      actorOrgRole: 'MEMBER',
    });
    expect(verdict).toMatchObject({ ok: false, code: 'DRIVE_TRASHED', status: 409 });
  });

  it('DRV-1 (partial) a non-owner learns nothing about the drive: someone else\'s Home drive answers NOT_DRIVE_OWNER, not HOME_DRIVE', () => {
    const verdict = decideMoveDriveIntoOrg({
      drive: personalProduct({ kind: 'HOME', orgId: null }),
      actorId: JONO,
      actorOrgRole: 'OWNER',
    });
    expect(verdict).toMatchObject({ ok: false, code: 'NOT_DRIVE_OWNER' });
  });
});

describe('decideMoveDriveOutOfOrg', () => {
  const orgProduct = { orgId: NORTHWIND };

  it.each(['OWNER', 'ADMIN'] as const)('DRV-2 (partial) an org %s may move a drive out', (role) => {
    expect(
      decideMoveDriveOutOfOrg({ drive: orgProduct, actorOrgRole: role, implicitMembers: 'keep' })
    ).toEqual({ ok: true, implicitMembers: 'keep' });
  });

  it('DRV-2 (partial) an org Member cannot move a drive out, even when they lead it', () => {
    expect(
      decideMoveDriveOutOfOrg({ drive: orgProduct, actorOrgRole: 'MEMBER', implicitMembers: 'remove' })
    ).toMatchObject({ ok: false, code: 'NOT_ORG_ADMIN', status: 403 });
  });

  it('DRV-2 (partial) a user outside the org cannot move a drive out', () => {
    expect(
      decideMoveDriveOutOfOrg({ drive: orgProduct, actorOrgRole: null, implicitMembers: 'remove' })
    ).toMatchObject({ ok: false, code: 'NOT_ORG_ADMIN', status: 403 });
  });

  it('DRV-2 (partial) a personal drive cannot be moved out of an org', () => {
    expect(
      decideMoveDriveOutOfOrg({ drive: { orgId: null }, actorOrgRole: 'OWNER', implicitMembers: 'keep' })
    ).toMatchObject({ ok: false, code: 'NOT_IN_ORG', status: 409 });
  });

  it('DRV-2 (partial) a caller who is not an org admin learns nothing about whether the drive is in an org', () => {
    expect(
      decideMoveDriveOutOfOrg({ drive: { orgId: null }, actorOrgRole: null, implicitMembers: 'keep' })
    ).toMatchObject({ ok: false, code: 'NOT_ORG_ADMIN', status: 403 });
  });

  it('D-OW-10 move-out carries the keep-or-remove choice through, and refuses when none was made', () => {
    expect(
      decideMoveDriveOutOfOrg({ drive: orgProduct, actorOrgRole: 'ADMIN', implicitMembers: 'remove' })
    ).toEqual({ ok: true, implicitMembers: 'remove' });
    expect(
      decideMoveDriveOutOfOrg({ drive: orgProduct, actorOrgRole: 'ADMIN', implicitMembers: null })
    ).toMatchObject({ ok: false, code: 'IMPLICIT_MEMBERS_CHOICE_REQUIRED', status: 400 });
  });
});

describe('decideCreateDriveInOrg', () => {
  it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)(
    'DRV-3 (partial) an org %s may create an org drive while the policy allows members',
    (role) => {
      expect(decideCreateDriveInOrg({ actorOrgRole: role, creationPolicy: 'members' })).toEqual({ ok: true });
    }
  );

  it('DRV-3 (partial) a user outside the org cannot create a drive in it', () => {
    expect(decideCreateDriveInOrg({ actorOrgRole: null, creationPolicy: 'members' })).toMatchObject({
      ok: false,
      code: 'NOT_ORG_MEMBER',
      status: 403,
    });
  });

  it('DRV-3 (partial) an admins-only creation policy refuses a Member and admits an Admin', () => {
    expect(decideCreateDriveInOrg({ actorOrgRole: 'MEMBER', creationPolicy: 'admins' })).toMatchObject({
      ok: false,
      code: 'POLICY_FORBIDS_CREATE',
      status: 403,
    });
    expect(decideCreateDriveInOrg({ actorOrgRole: 'ADMIN', creationPolicy: 'admins' })).toEqual({ ok: true });
  });
});

describe('canLeadOrgDrive', () => {
  it('D-OW-7 only an org member of any role can lead an org drive', () => {
    expect(canLeadOrgDrive('OWNER')).toBe(true);
    expect(canLeadOrgDrive('ADMIN')).toBe(true);
    expect(canLeadOrgDrive('MEMBER')).toBe(true);
    expect(canLeadOrgDrive(null)).toBe(false);
  });
});

describe('orgDriveVisibilityForInsert', () => {
  it('DRV-4 (partial) an unchosen visibility writes no column so the database default applies', () => {
    expect(orgDriveVisibilityForInsert(undefined)).toEqual({});
  });

  it('DRV-4 (partial) a chosen visibility is written as chosen', () => {
    expect(orgDriveVisibilityForInsert('PRIVATE')).toEqual({ orgVisibility: 'PRIVATE' });
  });
});

describe('named follow-up leaves', () => {
  it('points storage re-attribution and the creation policy at their board leaves', () => {
    expect(STORAGE_REATTRIBUTION_LEAF_ID).toBe('t1759m6mfxrj5hyaleu1mdqs');
    expect(ORG_DRIVE_CREATION_POLICY_LEAF_ID).toBe('lyt8275djmdcwlwm8wvk2xa5');
  });
});

describe('retryOnOrgSlugConflict', () => {
  // Drizzle 0.45 rethrows driver errors as DrizzleQueryError with the pg error on `.cause`.
  const drizzleError = (cause: { code: string; constraint?: string }) =>
    Object.assign(new Error('Failed query: insert into "drives"'), { cause });
  const orgSlugConflict = () => drizzleError({ code: '23505', constraint: ORG_DRIVE_SLUG_CONSTRAINT });

  it('DRV-3 (partial) re-runs the work after a per-org slug conflict and returns its result', async () => {
    let calls = 0;
    const result = await retryOnOrgSlugConflict(async () => {
      calls += 1;
      if (calls === 1) throw orgSlugConflict();
      return 'engineering-2';
    });
    expect(result).toBe('engineering-2');
    expect(calls).toBe(2);
  });

  it('DRV-3 (partial) never retries a unique violation on any other constraint', async () => {
    let calls = 0;
    const other = drizzleError({ code: '23505', constraint: 'drives_publishSubdomain_unique' });
    await expect(
      retryOnOrgSlugConflict(async () => {
        calls += 1;
        throw other;
      })
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  it('DRV-3 (partial) never retries an error that is not a unique violation, including a bare 23505 without the constraint', async () => {
    for (const error of [new Error('boom'), drizzleError({ code: '40P01' }), drizzleError({ code: '23505' })]) {
      let calls = 0;
      await expect(
        retryOnOrgSlugConflict(async () => {
          calls += 1;
          throw error;
        })
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('DRV-3 (partial) stops after ORG_SLUG_ATTEMPTS attempts of a persistent conflict and rethrows it', async () => {
    let calls = 0;
    const conflict = orgSlugConflict();
    await expect(
      retryOnOrgSlugConflict(async () => {
        calls += 1;
        // Runaway guard: an unbounded retry resolves here instead of hanging the suite.
        if (calls > 50) return 'runaway';
        throw conflict;
      })
    ).rejects.toBe(conflict);
    expect(calls).toBe(ORG_SLUG_ATTEMPTS);
    expect(ORG_SLUG_ATTEMPTS).toBe(5);
  });
});
