import { describe, it, expect } from 'vitest';
import {
  decideChangeDriveVisibility,
  decideChangeOrgDriveLead,
  type OrgDriveFactsForChange,
} from '../org-drive-ownership';

// Northwind Labs fixture (Sequence Spec Part 2): Jono owns the org, Priya is an Admin, Marcus
// leads the drive, Lena is a member, Chris Rowe is outside the org.
const JONO = 'user-jono';
const PRIYA = 'user-priya';
const MARCUS = 'user-marcus';
const LENA = 'user-lena';
const CHRIS = 'user-chris';

const product = (over: Partial<OrgDriveFactsForChange> = {}): OrgDriveFactsForChange => ({
  ownerId: MARCUS,
  orgId: 'org-northwind',
  orgVisibility: 'OPEN',
  isTrashed: false,
  ...over,
});

describe('decideChangeDriveVisibility', () => {
  it('DRV-4 (partial) the drive lead, the org Owner and an org Admin may change visibility', () => {
    for (const [actorId, actorOrgRole] of [[MARCUS, 'MEMBER'], [JONO, 'OWNER'], [PRIYA, 'ADMIN']] as const) {
      expect(decideChangeDriveVisibility({ drive: product(), actorId, actorOrgRole, visibility: 'RESTRICTED' }))
        .toEqual({ ok: true, changed: true, from: 'OPEN', to: 'RESTRICTED' });
    }
  });

  it('DRV-4 (partial) a plain org member who does not lead the drive cannot', () => {
    expect(decideChangeDriveVisibility({ drive: product(), actorId: LENA, actorOrgRole: 'MEMBER', visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
  });

  it('DRV-4 (partial) someone outside the org cannot, and a lead no longer in the org cannot either', () => {
    expect(decideChangeDriveVisibility({ drive: product(), actorId: CHRIS, actorOrgRole: null, visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
    expect(decideChangeDriveVisibility({ drive: product(), actorId: MARCUS, actorOrgRole: null, visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
  });

  it('DRV-4 (partial) a personal drive has no org visibility; its owner is told so, anyone else is refused', () => {
    expect(decideChangeDriveVisibility({ drive: product({ orgId: null }), actorId: MARCUS, actorOrgRole: null, visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'NOT_IN_ORG', status: 409 });
    expect(decideChangeDriveVisibility({ drive: product({ orgId: null }), actorId: PRIYA, actorOrgRole: null, visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
  });

  it('DRV-4 (partial) a trashed drive keeps its visibility until restored', () => {
    expect(decideChangeDriveVisibility({ drive: product({ isTrashed: true }), actorId: PRIYA, actorOrgRole: 'ADMIN', visibility: 'PRIVATE' }))
      .toMatchObject({ ok: false, code: 'DRIVE_TRASHED', status: 409 });
  });

  it('DRV-4 (partial) setting the visibility a drive already has changes nothing', () => {
    expect(decideChangeDriveVisibility({ drive: product({ orgVisibility: 'PRIVATE' }), actorId: PRIYA, actorOrgRole: 'ADMIN', visibility: 'PRIVATE' }))
      .toEqual({ ok: true, changed: false, from: 'PRIVATE', to: 'PRIVATE' });
  });
});

describe('decideChangeOrgDriveLead', () => {
  it('DRV-1 (partial) the current lead may hand the drive to another org member', () => {
    expect(decideChangeOrgDriveLead({ drive: product(), actorId: MARCUS, actorOrgRole: 'MEMBER', targetId: LENA, targetOrgRole: 'MEMBER' }))
      .toEqual({ ok: true, changed: true, fromUserId: MARCUS, toUserId: LENA });
  });

  it('DRV-1 (partial) an org Owner or Admin may set a new lead', () => {
    for (const [actorId, actorOrgRole] of [[JONO, 'OWNER'], [PRIYA, 'ADMIN']] as const) {
      expect(decideChangeOrgDriveLead({ drive: product(), actorId, actorOrgRole, targetId: LENA, targetOrgRole: 'MEMBER' }))
        .toEqual({ ok: true, changed: true, fromUserId: MARCUS, toUserId: LENA });
    }
  });

  it('DRV-1 (partial) a plain org member who does not lead the drive cannot', () => {
    expect(decideChangeOrgDriveLead({ drive: product(), actorId: LENA, actorOrgRole: 'MEMBER', targetId: LENA, targetOrgRole: 'MEMBER' }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
  });

  it('D-OW-7 the new lead must be an org member', () => {
    expect(decideChangeOrgDriveLead({ drive: product(), actorId: PRIYA, actorOrgRole: 'ADMIN', targetId: CHRIS, targetOrgRole: null }))
      .toMatchObject({ ok: false, code: 'TARGET_NOT_ORG_MEMBER', status: 409 });
  });

  it('DRV-1 (partial) a personal drive is not changed here: its owner is told it has no org, anyone else is refused', () => {
    expect(decideChangeOrgDriveLead({ drive: product({ orgId: null }), actorId: MARCUS, actorOrgRole: null, targetId: LENA, targetOrgRole: null }))
      .toMatchObject({ ok: false, code: 'NOT_IN_ORG', status: 409 });
    expect(decideChangeOrgDriveLead({ drive: product({ orgId: null }), actorId: PRIYA, actorOrgRole: null, targetId: LENA, targetOrgRole: null }))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
  });

  it('DRV-1 (partial) naming the current lead changes nothing', () => {
    expect(decideChangeOrgDriveLead({ drive: product(), actorId: PRIYA, actorOrgRole: 'ADMIN', targetId: MARCUS, targetOrgRole: 'MEMBER' }))
      .toEqual({ ok: true, changed: false, fromUserId: MARCUS, toUserId: MARCUS });
  });
});
