import { describe, it, expect } from 'vitest';
import { decideOrgInviteView, type OrgInviteViewInput } from '../invite-view-core';

const now = new Date('2026-10-12T12:00:00Z');
const live = { email: 'Tomas@Northwind.test', acceptedAt: null, expiresAt: new Date('2026-10-15T00:00:00Z') };
const expired = { ...live, expiresAt: new Date('2026-10-10T00:00:00Z') };
const used = { ...live, acceptedAt: new Date('2026-10-11T00:00:00Z') };
const tomas = { email: ' tomas@northwind.test', isMember: false };

const view = (input: Partial<OrgInviteViewInput>) =>
  decideOrgInviteView({ invite: live, viewer: null, invitedAccountExists: false, now, ...input });

describe('decideOrgInviteView', () => {
  it('ORG-3 (partial) a token no row holds (never issued, revoked, replaced by a resend) reads invalid, signed in or not', () => {
    expect(view({ invite: null })).toBe('invalid');
    expect(view({ invite: null, viewer: tomas })).toBe('invalid');
  });

  it('ORG-3 (partial) a signed-out visitor is sent to sign in when the invited address has an account, to sign up when not', () => {
    expect(view({ invitedAccountExists: true })).toBe('sign_in');
    expect(view({ invitedAccountExists: false })).toBe('sign_up');
  });

  it('ORG-3 (partial) the invited account (case-insensitive) may accept; any other signed-in account is the wrong account', () => {
    expect(view({ viewer: tomas })).toBe('accept');
    expect(view({ viewer: { email: 'marcus@northwind.test', isMember: false } })).toBe('wrong_account');
  });

  it('ORG-3 (partial) an expired link says expired; a used one reads invalid (never says by whom)', () => {
    expect(view({ invite: expired, viewer: tomas })).toBe('expired');
    expect(view({ invite: expired })).toBe('expired');
    expect(view({ invite: used, viewer: tomas })).toBe('invalid');
    expect(view({ invite: used })).toBe('invalid');
  });

  it('ORG-3 (partial) a member with a spent or stale link is already a member; a member holding a LIVE invite still accepts it so it stops holding a seat', () => {
    const member = { ...tomas, isMember: true };
    expect(view({ invite: used, viewer: member })).toBe('already_member');
    expect(view({ invite: expired, viewer: member })).toBe('already_member');
    expect(view({ invite: live, viewer: member })).toBe('accept');
  });
});
