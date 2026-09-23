/**
 * L2·G2 — who may CREATE an agent account (ADR 0004 §4.1: creating one is
 * `manage` + `grant` on an account that does not exist yet). A user-owned
 * account is created by its owner only — nobody attaches a credential to
 * someone else's personal settings. An agent-page-owned account is created by
 * a drive OWNER or ADMIN (the HUMAN's role, never an agent's membership);
 * a MEMBER who can edit the page may use such an account but not add one.
 */
import { describe, expect, it } from 'vitest';
import type { UserId } from '../../agent-accounts/grant';
import { decideAccountCreatePermission } from '../decide-account-create-permission';

const U = 'u1' as UserId;

describe('decideAccountCreatePermission', () => {
  it('given a user-owned account, should allow only the owner', () => {
    const actual = [decideAccountCreatePermission({ owner: { kind: 'user', userId: 'u1' }, actorUserId: U, humanDriveRole: null }), decideAccountCreatePermission({ owner: { kind: 'user', userId: 'u2' }, actorUserId: U, humanDriveRole: 'OWNER' })];
    const expected = [true, false];
    expect(actual).toEqual(expected);
  });

  it('given an agent-page-owned account, should allow drive OWNER and ADMIN and refuse MEMBER and non-members', () => {
    const owner = { kind: 'agent_page' as const, agentPageId: 'p', driveId: 'd' };
    const actual = (['OWNER', 'ADMIN', 'MEMBER', null] as const).map((humanDriveRole) => decideAccountCreatePermission({ owner, actorUserId: U, humanDriveRole }));
    const expected = [true, true, false, false];
    expect(actual).toEqual(expected);
  });
});
