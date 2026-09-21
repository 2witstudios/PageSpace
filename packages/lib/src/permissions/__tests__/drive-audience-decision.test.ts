import { describe, it, expect } from 'vitest';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { decideDriveAudience, type DriveAudienceInput } from '../org-drive-resolution';

const base = (overrides: Partial<DriveAudienceInput>): DriveAudienceInput => ({
  orgsEnabled: true,
  drive: { ownerId: 'lead', orgId: 'org', orgVisibility: 'OPEN' },
  rows: [],
  orgRoles: new Map<string, OrgRole>(),
  driveDefaultRole: { role: 'MEMBER', customRoleId: 'default-role' },
  ...overrides,
});
const summary = (input: DriveAudienceInput) =>
  decideDriveAudience(input).map((m) => `${m.userId}:${m.role}:${m.customRoleId ?? '-'}${m.isOwner ? ':lead' : ''}`);

describe('decideDriveAudience', () => {
  it('lists the lead first, once, even when the lead also holds a row', () => {
    expect(summary(base({ rows: [{ userId: 'lead', role: 'OWNER', customRoleId: null, source: 'invite' }] }))).toEqual(['lead:OWNER:-:lead']);
  });

  it('DRV-5 (partial) an org member with no row on an OPEN drive is a member with the drive default role; an org Admin is ADMIN', () => {
    const orgRoles = new Map<string, OrgRole>([['nina', 'MEMBER'], ['priya', 'ADMIN']]);
    expect(summary(base({ orgRoles }))).toEqual(['lead:OWNER:-:lead', 'nina:MEMBER:default-role', 'priya:ADMIN:-']);
  });

  it('X-6 (partial) a stale source=org row of someone no longer in the org is no member, and an org MEMBER is none on a PRIVATE drive without a row', () => {
    const input = base({
      drive: { ownerId: 'lead', orgId: 'org', orgVisibility: 'PRIVATE' },
      rows: [{ userId: 'dana', role: 'MEMBER', customRoleId: null, source: 'org' }],
      orgRoles: new Map<string, OrgRole>([['nina', 'MEMBER'], ['jono', 'OWNER']]),
    });
    expect(summary(input)).toEqual(['lead:OWNER:-:lead', 'jono:ADMIN:-']);
  });

  it('while dark, or on a personal drive, it is the lead plus every accepted row as it is', () => {
    const rows = [
      { userId: 'marcus', role: 'MEMBER' as const, customRoleId: null, source: 'org' as const },
      { userId: 'fred', role: 'OWNER' as const, customRoleId: null, source: 'invite' as const },
    ];
    const orgRoles = new Map<string, OrgRole>([['nina', 'MEMBER']]);
    expect(summary(base({ orgsEnabled: false, rows, orgRoles }))).toEqual(['lead:OWNER:-:lead', 'marcus:MEMBER:-', 'fred:OWNER:-']);
    expect(summary(base({ drive: { ownerId: 'lead', orgId: null, orgVisibility: 'OPEN' }, rows, orgRoles }))).toEqual(['lead:OWNER:-:lead', 'marcus:MEMBER:-', 'fred:OWNER:-']);
  });
});
