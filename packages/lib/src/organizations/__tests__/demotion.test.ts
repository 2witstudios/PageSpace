import { describe, it, expect } from 'vitest';
import { memberCouldSharePage, planDemotionRevocation, type DemotionDrive } from '../demotion';

const USER = 'user_priya';
const drive = (overrides: Partial<DemotionDrive>): DemotionDrive => ({
  driveId: 'drive_x',
  orgId: 'org_northwind',
  leadId: 'user_lena',
  orgVisibility: 'OPEN',
  row: null,
  defaultCustomRoleId: null,
  ...overrides,
});

describe('planDemotionRevocation', () => {
  it('ORG-4 (partial) an Admin demoted to Member loses every drive org power alone opened, and keeps Member reach on OPEN drives capped to the default role', () => {
    const plan = planDemotionRevocation({
      userId: USER,
      fromRole: 'ADMIN',
      toRole: 'MEMBER',
      drives: [
        drive({ driveId: 'drive_product', orgVisibility: 'OPEN', defaultCustomRoleId: 'role_contributor' }),
        drive({ driveId: 'drive_research', orgVisibility: 'RESTRICTED' }),
        drive({ driveId: 'drive_finance', orgVisibility: 'PRIVATE' }),
      ],
    });

    expect(plan).toEqual({
      revokeAll: ['drive_research', 'drive_finance'],
      capToMember: [{ driveId: 'drive_product', customRoleId: 'role_contributor' }],
    });
  });

  it('ORG-4 (partial) demotion revokes nothing a row still backs: an invited ADMIN row keeps admin reach, an invited MEMBER row keeps member reach', () => {
    const plan = planDemotionRevocation({
      userId: USER,
      fromRole: 'ADMIN',
      toRole: 'MEMBER',
      drives: [
        drive({ driveId: 'drive_finance', orgVisibility: 'PRIVATE', row: { role: 'ADMIN', customRoleId: null, source: 'invite' } }),
        drive({ driveId: 'drive_research', orgVisibility: 'RESTRICTED', row: { role: 'MEMBER', customRoleId: 'role_reader', source: 'invite' } }),
      ],
    });

    expect(plan).toEqual({
      revokeAll: [],
      capToMember: [{ driveId: 'drive_research', customRoleId: 'role_reader' }],
    });
  });

  it('ORG-4 (partial) stale rows back nothing: an org row on a PRIVATE drive or a former lead\'s OWNER row does not save the drive from revocation', () => {
    const plan = planDemotionRevocation({
      userId: USER,
      fromRole: 'ADMIN',
      toRole: 'MEMBER',
      drives: [
        drive({ driveId: 'drive_finance', orgVisibility: 'PRIVATE', row: { role: 'MEMBER', customRoleId: null, source: 'org' } }),
        drive({ driveId: 'drive_legal', orgVisibility: 'PRIVATE', row: { role: 'OWNER', customRoleId: null, source: 'invite' } }),
      ],
    });

    expect(plan.revokeAll).toEqual(['drive_finance', 'drive_legal']);
  });

  it('a drive the demoted person leads is theirs, and an Owner becoming Admin keeps the same org power, so neither revokes anything', () => {
    expect(planDemotionRevocation({
      userId: USER,
      fromRole: 'ADMIN',
      toRole: 'MEMBER',
      drives: [drive({ driveId: 'drive_led', leadId: USER, orgVisibility: 'PRIVATE' })],
    })).toEqual({ revokeAll: [], capToMember: [] });

    expect(planDemotionRevocation({
      userId: USER,
      fromRole: 'OWNER',
      toRole: 'ADMIN',
      drives: [drive({ orgVisibility: 'PRIVATE' }), drive({ driveId: 'drive_y', orgVisibility: 'OPEN' })],
    })).toEqual({ revokeAll: [], capToMember: [] });
  });
});

describe('memberCouldSharePage', () => {
  const role = { permissions: { page_a: { canView: true, canEdit: false, canShare: true } }, driveWidePermissions: { canView: true, canEdit: false, canShare: true } };

  it('ORG-4 (partial) mirrors getUserAccessLevel for a MEMBER: an explicit grant decides, then the custom role (drive-wide never on a private page), else no share', () => {
    expect(memberCouldSharePage({ pageId: 'page_a', isPrivate: false, explicitCanShare: true, customRole: null })).toBe(true);
    expect(memberCouldSharePage({ pageId: 'page_a', isPrivate: false, explicitCanShare: false, customRole: role })).toBe(false);
    expect(memberCouldSharePage({ pageId: 'page_a', isPrivate: true, explicitCanShare: null, customRole: role })).toBe(true);
    expect(memberCouldSharePage({ pageId: 'page_b', isPrivate: false, explicitCanShare: null, customRole: role })).toBe(true);
    expect(memberCouldSharePage({ pageId: 'page_b', isPrivate: true, explicitCanShare: null, customRole: role })).toBe(false);
    expect(memberCouldSharePage({ pageId: 'page_b', isPrivate: false, explicitCanShare: null, customRole: null })).toBe(false);
  });
});
