import { describe, it, expect } from 'vitest';
import { decideAppUnparkAuthority, type AppUnparkAuthorityInput } from '../app-unpark-authority';

const orgDrive = { ownerId: 'lead', orgId: 'org-1' };
const base: AppUnparkAuthorityInput = { orgsEnabled: true, userId: 'x', drive: orgDrive, orgRole: null, costOwnerId: 'creator', isDriveMember: false };

describe('decideAppUnparkAuthority', () => {
  it('WAL-2 (partial) the drive lead may un-park', () => {
    expect(decideAppUnparkAuthority({ ...base, userId: 'lead' })).toEqual({ allowed: true, via: 'lead' });
  });

  it('WAL-2 (partial) an org Owner or Admin may un-park on an org drive', () => {
    expect(decideAppUnparkAuthority({ ...base, orgRole: 'OWNER' })).toEqual({ allowed: true, via: 'org-owner' });
    expect(decideAppUnparkAuthority({ ...base, orgRole: 'ADMIN' })).toEqual({ allowed: true, via: 'org-admin' });
  });

  it('WAL-2 (partial) org power is nothing while orgs are dark or on a personal drive', () => {
    expect(decideAppUnparkAuthority({ ...base, orgRole: 'ADMIN', orgsEnabled: false })).toEqual({ allowed: false });
    expect(decideAppUnparkAuthority({ ...base, orgRole: 'ADMIN', drive: { ownerId: 'lead', orgId: null } })).toEqual({ allowed: false });
  });

  it('WAL-2 (partial) the creator may un-park while still a member of the drive, and not once removed from it', () => {
    expect(decideAppUnparkAuthority({ ...base, userId: 'creator', orgRole: 'MEMBER', isDriveMember: true })).toEqual({ allowed: true, via: 'creator' });
    expect(decideAppUnparkAuthority({ ...base, userId: 'creator', orgRole: 'MEMBER', isDriveMember: false })).toEqual({ allowed: false });
  });

  it('WAL-2 (partial) a plain member who is not the creator is refused, even as a drive member', () => {
    expect(decideAppUnparkAuthority({ ...base, userId: 'pat', orgRole: 'MEMBER', isDriveMember: true })).toEqual({ allowed: false });
  });

  it('WAL-2 (partial) an app with no cost owner (the lead\'s) has no creator to admit', () => {
    expect(decideAppUnparkAuthority({ ...base, userId: 'pat', costOwnerId: null, isDriveMember: true })).toEqual({ allowed: false });
  });
});
