/**
 * Organizations & Wallets, Wave B3 — the pure decisions behind org services.
 * No IO: every rule a route or repository enforces is decided here first.
 */
import { describe, it, expect } from 'vitest';
import { ORG_ROLE_RANK, decideOrgRole } from '../authorize';
import {
  decideInviteCreation,
  decideInviteAcceptance,
  isLiveInvite,
  inviteExpiryFrom,
  INVITE_EXPIRY_DAYS,
} from '../invitations';
import { decideRoleChange, decideMemberRemoval, decideOwnershipTransfer } from '../membership';
import { planOrgDeletion } from '../deletion';
import { decideOrgOwnerCandidate } from '../owner-candidate';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('decideOrgRole', () => {
  it('ORG-5 (partial) ranks Owner above Admin above Member', () => {
    expect(ORG_ROLE_RANK.OWNER).toBeGreaterThan(ORG_ROLE_RANK.ADMIN);
    expect(ORG_ROLE_RANK.ADMIN).toBeGreaterThan(ORG_ROLE_RANK.MEMBER);
  });

  it('ORG-5 (partial) a non-member is refused as not found so the org is not disclosed', () => {
    expect(decideOrgRole({ membershipRole: null, minRole: 'MEMBER' })).toEqual({
      ok: false,
      status: 404,
      reason: 'not_member',
    });
  });

  it('ORG-5 (partial) a member below the minimum role is forbidden', () => {
    expect(decideOrgRole({ membershipRole: 'MEMBER', minRole: 'ADMIN' })).toEqual({
      ok: false,
      status: 403,
      reason: 'insufficient_role',
    });
    expect(decideOrgRole({ membershipRole: 'ADMIN', minRole: 'OWNER' })).toEqual({
      ok: false,
      status: 403,
      reason: 'insufficient_role',
    });
  });

  it('ORG-5 (partial) a member at or above the minimum role is allowed with their role', () => {
    expect(decideOrgRole({ membershipRole: 'OWNER', minRole: 'ADMIN' })).toEqual({ ok: true, role: 'OWNER' });
    expect(decideOrgRole({ membershipRole: 'ADMIN', minRole: 'ADMIN' })).toEqual({ ok: true, role: 'ADMIN' });
    expect(decideOrgRole({ membershipRole: 'MEMBER', minRole: 'MEMBER' })).toEqual({ ok: true, role: 'MEMBER' });
  });
});

describe('invitation decisions', () => {
  it('ORG-3 (partial) an invite expires INVITE_EXPIRY_DAYS after it is issued', () => {
    expect(INVITE_EXPIRY_DAYS).toBe(7);
    expect(inviteExpiryFrom(NOW).toISOString()).toBe('2026-09-24T12:00:00.000Z');
  });

  it('SEAT-3 (partial) only an unaccepted, unexpired invite is live', () => {
    expect(isLiveInvite({ acceptedAt: null, expiresAt: new Date(NOW.getTime() + HOUR) }, NOW)).toBe(true);
    expect(isLiveInvite({ acceptedAt: null, expiresAt: new Date(NOW.getTime() - HOUR) }, NOW)).toBe(false);
    expect(isLiveInvite({ acceptedAt: null, expiresAt: NOW }, NOW)).toBe(false);
    expect(isLiveInvite({ acceptedAt: NOW, expiresAt: new Date(NOW.getTime() + HOUR) }, NOW)).toBe(false);
  });

  it('ORG-3 (partial) inviting a fresh address inserts an invite', () => {
    expect(decideInviteCreation({ isExistingMember: false, openInvite: null, now: NOW })).toEqual({ action: 'insert' });
  });

  it('ORG-3 (partial) inviting an existing member is refused', () => {
    expect(decideInviteCreation({ isExistingMember: true, openInvite: null, now: NOW })).toEqual({
      action: 'refuse',
      reason: 'already_member',
    });
  });

  it('ORG-3 (partial) inviting an address with a live invite is refused in favour of resend', () => {
    const openInvite = { id: 'inv-1', acceptedAt: null, expiresAt: new Date(NOW.getTime() + HOUR) };
    expect(decideInviteCreation({ isExistingMember: false, openInvite, now: NOW })).toEqual({
      action: 'refuse',
      reason: 'already_invited',
    });
  });

  it('ORG-3 (partial) re-inviting after expiry rotates the open invite', () => {
    const openInvite = { id: 'inv-1', acceptedAt: null, expiresAt: new Date(NOW.getTime() - HOUR) };
    expect(decideInviteCreation({ isExistingMember: false, openInvite, now: NOW })).toEqual({
      action: 'rotate',
      invitationId: 'inv-1',
    });
  });

  const liveInvite = {
    email: 'Marcus.Oyelaran@Northwind.test',
    acceptedAt: null,
    expiresAt: new Date(NOW.getTime() + HOUR),
  };

  it('ORG-3 (partial) acceptance refuses an unknown token', () => {
    expect(
      decideInviteAcceptance({ invite: null, userEmail: 'marcus.oyelaran@northwind.test', isExistingMember: false, now: NOW }),
    ).toEqual({ ok: false, status: 404, reason: 'not_found' });
  });

  it('ORG-3 (partial) acceptance refuses an expired invite', () => {
    const invite = { ...liveInvite, expiresAt: new Date(NOW.getTime() - HOUR) };
    expect(
      decideInviteAcceptance({ invite, userEmail: 'marcus.oyelaran@northwind.test', isExistingMember: false, now: NOW }),
    ).toEqual({ ok: false, status: 410, reason: 'expired' });
  });

  it('ORG-3 (partial) acceptance refuses an already accepted invite', () => {
    const invite = { ...liveInvite, acceptedAt: new Date(NOW.getTime() - HOUR) };
    expect(
      decideInviteAcceptance({ invite, userEmail: 'marcus.oyelaran@northwind.test', isExistingMember: false, now: NOW }),
    ).toEqual({ ok: false, status: 410, reason: 'already_accepted' });
  });

  it('ORG-3 (partial) acceptance refuses an account whose email is not the invited address', () => {
    expect(
      decideInviteAcceptance({ invite: liveInvite, userEmail: 'lena.schulz@northwind.test', isExistingMember: false, now: NOW }),
    ).toEqual({ ok: false, status: 403, reason: 'email_mismatch' });
  });

  it('ORG-3 (partial) acceptance matches the invited address case-insensitively and joins', () => {
    expect(
      decideInviteAcceptance({ invite: liveInvite, userEmail: 'marcus.oyelaran@northwind.test', isExistingMember: false, now: NOW }),
    ).toEqual({ ok: true, action: 'join' });
  });

  it('ORG-3 (partial) acceptance by someone already a member consumes the invite without a second row', () => {
    expect(
      decideInviteAcceptance({ invite: liveInvite, userEmail: 'marcus.oyelaran@northwind.test', isExistingMember: true, now: NOW }),
    ).toEqual({ ok: true, action: 'consume_only' });
  });
});

describe('membership decisions', () => {
  it('ORG-2 (partial) an Admin can make a Member an Admin and back', () => {
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'marcus', targetRole: 'MEMBER', newRole: 'ADMIN' })).toEqual({ ok: true });
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'dana', targetRole: 'ADMIN', newRole: 'MEMBER' })).toEqual({ ok: true });
  });

  it('ORG-2 (partial) a role change on a non-member is not found', () => {
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'chris', targetRole: null, newRole: 'ADMIN' })).toEqual({
      ok: false,
      status: 404,
      reason: 'target_not_member',
    });
  });

  it('ORG-1 (partial) the Owner role is never granted or removed by a role change, only by transfer', () => {
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'marcus', targetRole: 'MEMBER', newRole: 'OWNER' })).toEqual({
      ok: false,
      status: 400,
      reason: 'use_ownership_transfer',
    });
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'jono', targetRole: 'OWNER', newRole: 'MEMBER' })).toEqual({
      ok: false,
      status: 400,
      reason: 'use_ownership_transfer',
    });
  });

  it('ORG-2 (partial) removing the Owner is refused and removing yourself is leaving', () => {
    expect(decideMemberRemoval({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'jono', targetRole: 'OWNER' })).toEqual({
      ok: false,
      status: 400,
      reason: 'use_ownership_transfer',
    });
    expect(decideMemberRemoval({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'priya', targetRole: 'ADMIN' })).toEqual({
      ok: false,
      status: 400,
      reason: 'use_leave',
    });
    expect(decideMemberRemoval({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'chris', targetRole: null })).toEqual({
      ok: false,
      status: 404,
      reason: 'target_not_member',
    });
    expect(decideMemberRemoval({ actorId: 'priya', actorRole: 'ADMIN', targetId: 'marcus', targetRole: 'MEMBER' })).toEqual({ ok: true });
  });

  it('ORG-5 (partial) a role change or removal re-checks the actor, who may have lost the Admin role since the route authorized', () => {
    expect(decideRoleChange({ actorId: 'priya', actorRole: 'MEMBER', targetId: 'marcus', targetRole: 'MEMBER', newRole: 'ADMIN' })).toEqual({
      ok: false,
      status: 403,
      reason: 'insufficient_role',
    });
    expect(decideMemberRemoval({ actorId: 'priya', actorRole: null, targetId: 'marcus', targetRole: 'MEMBER' })).toEqual({
      ok: false,
      status: 404,
      reason: 'not_member',
    });
  });

  it('ORG-1 (partial) ownership transfers only from the current Owner to another member', () => {
    expect(decideOwnershipTransfer({ currentOwnerId: 'jono', actorId: 'jono', targetId: 'priya', targetRole: 'ADMIN', targetKind: 'human' })).toEqual({ ok: true });
    expect(decideOwnershipTransfer({ currentOwnerId: 'jono', actorId: 'jono', targetId: 'chris', targetRole: null, targetKind: null })).toEqual({
      ok: false,
      status: 400,
      reason: 'target_not_member',
    });
    expect(decideOwnershipTransfer({ currentOwnerId: 'jono', actorId: 'jono', targetId: 'jono', targetRole: 'OWNER', targetKind: 'human' })).toEqual({
      ok: false,
      status: 400,
      reason: 'already_owner',
    });
    expect(decideOwnershipTransfer({ currentOwnerId: 'jono', actorId: 'priya', targetId: 'dana', targetRole: 'ADMIN', targetKind: 'human' })).toEqual({
      ok: false,
      status: 403,
      reason: 'not_owner',
    });
  });

  it('ORG-1 (partial) only a person can become an org Owner, at creation or by transfer', () => {
    expect(decideOrgOwnerCandidate('human')).toEqual({ ok: true });
    expect(decideOrgOwnerCandidate('agent')).toEqual({ ok: false, status: 400, reason: 'owner_not_human' });
    expect(decideOrgOwnerCandidate(null)).toEqual({ ok: false, status: 404, reason: 'owner_not_found' });
    expect(decideOwnershipTransfer({ currentOwnerId: 'jono', actorId: 'jono', targetId: 'agent-page', targetRole: null, targetKind: 'agent' })).toEqual({
      ok: false,
      status: 400,
      reason: 'owner_not_human',
    });
  });
});

describe('planOrgDeletion', () => {
  const base = {
    actorId: 'jono',
    ownerId: 'jono',
    memberIds: ['jono', 'priya', 'marcus'],
  };
  const product = { id: 'd-product', name: 'Product', isTrashed: false };
  const finance = { id: 'd-finance', name: 'Finance', isTrashed: false };
  const oldSite = { id: 'd-old', name: 'Old Site', isTrashed: true };

  it('ORG-6 (partial) plans a transfer to a named member and a trash into the Owner trash', () => {
    const plan = planOrgDeletion({
      ...base,
      drives: [product, finance],
      choices: [
        { driveId: 'd-product', action: 'transfer', toUserId: 'priya' },
        { driveId: 'd-finance', action: 'trash' },
      ],
    });
    expect(plan).toEqual({
      ok: true,
      steps: [
        { driveId: 'd-product', driveName: 'Product', destination: 'transfer', ownerId: 'priya', trashed: false },
        { driveId: 'd-finance', driveName: 'Finance', destination: 'owner_trash', ownerId: 'jono', trashed: true },
      ],
    });
  });

  it('ORG-6 (partial) an already-trashed drive always goes to the Owner trash without a choice', () => {
    const plan = planOrgDeletion({ ...base, drives: [oldSite], choices: [] });
    expect(plan).toEqual({
      ok: true,
      steps: [{ driveId: 'd-old', driveName: 'Old Site', destination: 'owner_trash', ownerId: 'jono', trashed: true }],
    });
  });

  it('ORG-6 (partial) a live drive without a choice is refused so nothing moves silently', () => {
    expect(planOrgDeletion({ ...base, drives: [product], choices: [] })).toEqual({
      ok: false,
      reason: 'missing_choice',
      driveIds: ['d-product'],
    });
  });

  it('ORG-6 (partial) a transfer target who is not an org member is refused', () => {
    expect(
      planOrgDeletion({
        ...base,
        drives: [product],
        choices: [{ driveId: 'd-product', action: 'transfer', toUserId: 'chris' }],
      }),
    ).toEqual({ ok: false, reason: 'transfer_target_not_member', driveIds: ['d-product'] });
  });

  it('ORG-6 (partial) a choice naming a drive that is not the org’s, or already trashed, is refused', () => {
    expect(
      planOrgDeletion({ ...base, drives: [product], choices: [
        { driveId: 'd-product', action: 'trash' },
        { driveId: 'd-elsewhere', action: 'trash' },
      ] }),
    ).toEqual({ ok: false, reason: 'unknown_drive', driveIds: ['d-elsewhere'] });
    expect(
      planOrgDeletion({ ...base, drives: [oldSite], choices: [{ driveId: 'd-old', action: 'transfer', toUserId: 'priya' }] }),
    ).toEqual({ ok: false, reason: 'drive_already_trashed', driveIds: ['d-old'] });
  });

  it('ORG-6 (partial) a caller who is not the Owner at the time of the write is refused', () => {
    expect(planOrgDeletion({ ...base, actorId: 'priya', drives: [product], choices: [{ driveId: 'd-product', action: 'trash' }] })).toEqual({
      ok: false,
      reason: 'not_owner',
      driveIds: [],
    });
  });

  it('ORG-6 (partial) two choices for one drive are refused', () => {
    expect(
      planOrgDeletion({ ...base, drives: [product], choices: [
        { driveId: 'd-product', action: 'trash' },
        { driveId: 'd-product', action: 'transfer', toUserId: 'priya' },
      ] }),
    ).toEqual({ ok: false, reason: 'duplicate_choice', driveIds: ['d-product'] });
  });
});
