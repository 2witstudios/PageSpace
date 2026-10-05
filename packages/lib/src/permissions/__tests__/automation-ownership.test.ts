import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_OWNER_CHANGED_ERROR,
  AUTOMATION_OWNER_LEFT_ERROR,
  automationRunOwner,
  claimedRunOwner,
  decideOwnerLeftAutomationAction,
  departedCreatorDisposition,
} from '../automation-ownership';

const LEFT_AT = new Date('2026-10-05T10:00:00Z');

describe('automationRunOwner', () => {
  it('SPEND-6 (partial) an automation whose creator stands behind it runs as that creator', () => {
    expect(automationRunOwner({ createdBy: 'marcus', ownerLeftAt: null })).toEqual({ runs: true, ownerId: 'marcus' });
  });

  it('SPEND-6 (partial) an automation flagged owner-left does not run, even while its creator column still names the person who left', () => {
    expect(automationRunOwner({ createdBy: 'marcus', ownerLeftAt: LEFT_AT })).toEqual({
      runs: false,
      reason: 'owner_left',
      error: AUTOMATION_OWNER_LEFT_ERROR,
    });
  });

  it('SPEND-6 (partial) an automation with no creator (the account was deleted) does not run: nothing runs under a missing person', () => {
    expect(automationRunOwner({ createdBy: null, ownerLeftAt: null })).toMatchObject({ runs: false, reason: 'owner_left' });
    expect(automationRunOwner({ createdBy: null, ownerLeftAt: LEFT_AT })).toMatchObject({ runs: false, reason: 'owner_left' });
  });

  it('the recorded reason names owner_left and tells an admin what to do', () => {
    expect(AUTOMATION_OWNER_LEFT_ERROR).toContain('owner_left');
    expect(AUTOMATION_OWNER_LEFT_ERROR).toMatch(/reassign or delete/);
  });
});

describe('claimedRunOwner', () => {
  it('SPEND-6 (partial) a claimed run proceeds as the owner it was scheduled as', () => {
    expect(claimedRunOwner({ createdBy: 'lena', ownerLeftAt: null }, 'lena')).toEqual({ runs: true, ownerId: 'lena' });
  });

  it('SPEND-6 (partial) a run scheduled as the old creator of a since-reassigned workflow is skipped owner_changed, never run as them (review #2831 P2-2)', () => {
    expect(claimedRunOwner({ createdBy: 'lena', ownerLeftAt: null }, 'marcus')).toEqual({ runs: false, reason: 'owner_changed', error: AUTOMATION_OWNER_CHANGED_ERROR });
  });

  it('SPEND-6 (partial) an owner-left workflow is refused owner_left whoever it was scheduled as; no comparison is made for a source that runs as its scheduler', () => {
    expect(claimedRunOwner({ createdBy: 'marcus', ownerLeftAt: LEFT_AT }, 'marcus')).toMatchObject({ runs: false, reason: 'owner_left' });
    expect(claimedRunOwner({ createdBy: 'lena', ownerLeftAt: null }, null)).toEqual({ runs: true, ownerId: 'lena' });
  });
});

describe('departedCreatorDisposition', () => {
  it('SPEND-6 (partial) an ORG drive\'s automation is disabled and flagged when its creator leaves the org or deletes their account', () => {
    expect(departedCreatorDisposition({ orgId: 'org-1' }, 'left_org')).toBe('disable');
    expect(departedCreatorDisposition({ orgId: 'org-1' }, 'account_deleted')).toBe('disable');
  });

  it('a PERSONAL drive\'s automation keeps today\'s behaviour: it goes with its creator\'s account, and leaving an org does not reach it', () => {
    expect(departedCreatorDisposition({ orgId: null }, 'account_deleted')).toBe('delete');
    expect(departedCreatorDisposition({ orgId: null }, 'left_org')).toBe('keep');
  });
});

describe('decideOwnerLeftAutomationAction', () => {
  const automation = { orgId: 'org-1', ownerLeftAt: LEFT_AT };
  const eligible = { isOrgMember: true, isDriveMember: true };

  it('SPEND-6 (partial) an org Owner or Admin may reassign an owner-left automation to an accepted member who can reach its drive', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: eligible } })).toEqual({ ok: true });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'ADMIN', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: eligible } })).toEqual({ ok: true });
  });

  it('SPEND-6 (partial) an org Owner or Admin may delete an owner-left automation', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'ADMIN', orgId: 'org-1', automation, action: { kind: 'delete' } })).toEqual({ ok: true });
  });

  it('SPEND-6 (partial) a plain member cannot reassign or delete (403), and a non-member learns nothing (404)', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'MEMBER', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: eligible } }))
      .toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'MEMBER', orgId: 'org-1', automation, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(decideOwnerLeftAutomationAction({ actorRole: null, orgId: 'org-1', automation, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 404, reason: 'not_member' });
  });

  it('an automation in another org\'s drive, or in a personal drive, is not this org\'s to touch (404, not a leak)', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation: { orgId: 'org-2', ownerLeftAt: LEFT_AT }, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation: { orgId: null, ownerLeftAt: LEFT_AT }, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation: null, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 404, reason: 'not_found' });
  });

  it('an automation whose owner has NOT left is its owner\'s; this admin path refuses it (409)', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation: { orgId: 'org-1', ownerLeftAt: null }, action: { kind: 'reassign', newOwner: eligible } }))
      .toEqual({ ok: false, status: 409, reason: 'owner_present' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation: { orgId: 'org-1', ownerLeftAt: null }, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 409, reason: 'owner_present' });
  });

  it('SPEND-6 (partial) the new owner must be an ACCEPTED org member (a guest or a pending invitee is not) who can reach the drive', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: { isOrgMember: false, isDriveMember: true } } }))
      .toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: { isOrgMember: true, isDriveMember: false } } }))
      .toEqual({ ok: false, status: 400, reason: 'new_owner_no_drive_access' });
    expect(decideOwnerLeftAutomationAction({ actorRole: 'OWNER', orgId: 'org-1', automation, action: { kind: 'reassign', newOwner: null } }))
      .toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
  });

  it('role is decided before anything about the automation is revealed: a member asking about a foreign automation gets 403, not 404', () => {
    expect(decideOwnerLeftAutomationAction({ actorRole: 'MEMBER', orgId: 'org-1', automation: null, action: { kind: 'delete' } }))
      .toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
  });
});
