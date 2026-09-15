/**
 * ADR 0004 §4 + §8.14–16, §8.23; ADR 0005 §10.18 — the four account
 * permissions plus the default-off `session_http` exception, decided over
 * repository-fetched facts. Written RED at G1b before
 * `decide-account-access.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import { decideAccountAccess } from '../decide-account-access';
import type { AccountAccessFacts, AccountAccessLevel, AccountPermission } from '../account-permissions';
import type { AgentPageId, DriveId, UserId } from '../../agent-accounts/grant';
import type { AccountId } from '@pagespace/db/schema/agent-accounts';

const OWNER = 'user_owner' as UserId;
const OTHER = 'user_other' as UserId;
const PAGE = 'page_agent' as AgentPageId;
const DRIVE = 'drive_1' as DriveId;

const none: AccountAccessLevel = { view: false, use: false, manage: false, grant: false, session_http: false };

function userOwned(overrides: Partial<AccountAccessFacts> = {}): AccountAccessFacts {
  return {
    accountId: 'acct_1' as AccountId,
    kind: 'api_key',
    status: 'active',
    owner: { kind: 'user', userId: OWNER },
    accountDriveId: null,
    actorUserId: OWNER,
    actingHumanUserId: OWNER,
    humanDriveRole: null,
    humanCanEditAgentPage: false,
    agentPageId: PAGE,
    agentBoundToAccount: true,
    delegation: { kind: 'live_session' },
    sessionHttpEnabled: false,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    ceilingAdmitsAccount: true,
    ...overrides,
  };
}

function agentOwned(overrides: Partial<AccountAccessFacts> = {}): AccountAccessFacts {
  return userOwned({
    owner: { kind: 'agent_page', agentPageId: PAGE, driveId: DRIVE },
    accountDriveId: DRIVE,
    actorUserId: OTHER,
    actingHumanUserId: OTHER,
    humanDriveRole: 'MEMBER',
    humanCanEditAgentPage: false,
    ...overrides,
  });
}

const decide = (facts: AccountAccessFacts) => decideAccountAccess({ facts });

describe('decideAccountAccess — what never grants anything (ADR 0004 §4.2)', () => {
  it('given every page permission true and no account relationship, should return view/use/manage/grant/session_http all false [0004 §8.14]', () => {
    const actual = decide(userOwned({ actorUserId: OTHER, actingHumanUserId: OTHER, humanDriveRole: 'OWNER', humanCanEditAgentPage: true, agentBoundToAccount: true, sessionHttpEnabled: true, kind: 'session' }));
    expect(actual).toEqual(none);
  });

  it('given drive membership, workspace ownership and conversation access with no account relationship, should return all false', () => {
    const actual = decide(userOwned({ actorUserId: OTHER, actingHumanUserId: OTHER, humanDriveRole: 'MEMBER', humanCanEditAgentPage: true }));
    expect(actual).toEqual(none);
  });
});

describe('use', () => {
  it('given a user-owned account and an acting human who is not the owner (a shared agent invoked by another member), should return use false even when the agent page is bound [0004 §8.15]', () => {
    const actual = decide(userOwned({ actorUserId: OTHER, actingHumanUserId: OTHER, agentBoundToAccount: true })).use;
    expect(actual).toBe(false);
  });

  it('given a user-owned account, the owner as actor but another human as the acting human of the run, should return use false', () => {
    const actual = decide(userOwned({ actorUserId: OWNER, actingHumanUserId: OTHER })).use;
    expect(actual).toBe(false);
  });

  it('given a user-owned account, the owner as acting human, and a bound agent page, should return use true', () => {
    const actual = decide(userOwned());
    expect(actual).toEqual({ view: true, use: true, manage: true, grant: true, session_http: false });
  });

  it('given a user-owned account, the owner as acting human, and an UNBOUND agent page, should return use false (binding is explicit)', () => {
    const actual = decide(userOwned({ agentBoundToAccount: false })).use;
    expect(actual).toBe(false);
  });

  it('given a user-owned account used by the owner through the global assistant (no agent page), should return use true', () => {
    const actual = decide(userOwned({ agentPageId: null, agentBoundToAccount: false })).use;
    expect(actual).toBe(true);
  });

  it('given an agent-page-owned account whose drive the caller ceiling does not admit, should return use false (ceiling first)', () => {
    const actual = decide(agentOwned({ humanDriveRole: 'OWNER', callerCeiling: { allowedDriveIds: ['drive_other'], originatingMcpTokenId: 'mcp' }, ceilingAdmitsAccount: false }));
    expect(actual).toEqual(none);
  });

  it('given an agent-page-owned account and a drive member driving its owner page, should return use true', () => {
    const actual = decide(agentOwned()).use;
    expect(actual).toBe(true);
  });

  it('given an agent-page-owned account and a run driving a DIFFERENT agent page, should return use false', () => {
    const actual = decide(agentOwned({ agentPageId: 'page_other' as AgentPageId })).use;
    expect(actual).toBe(false);
  });

  it('given an unattended run with no delegation fact, should return use false', () => {
    const actual = [decide(userOwned({ delegation: { kind: 'none' } })).use, decide(agentOwned({ delegation: { kind: 'none' } })).use];
    expect(actual).toEqual([false, false]);
  });

  it('given an unattended run with a live delegation for this account, should return use true; expired, revoked or foreign, false', () => {
    const live = { kind: 'delegation' as const, delegationId: 'dlg' as never, accountId: 'acct_1' as AccountId, expired: false, revoked: false };
    const actual = [
      decide(userOwned({ delegation: live })).use,
      decide(userOwned({ delegation: { ...live, expired: true } })).use,
      decide(userOwned({ delegation: { ...live, revoked: true } })).use,
      decide(userOwned({ delegation: { ...live, accountId: 'acct_other' as AccountId } })).use,
    ];
    expect(actual).toEqual([true, false, false, false]);
  });

  it.each(['revoked', 'needs_reauth', 'deleted'] as const)('given account status %s, should return use false while view stays decidable', (status) => {
    const actual = decide(userOwned({ status }));
    expect({ use: actual.use, view: actual.view }).toEqual({ use: false, view: true });
  });
});

describe('manage and grant', () => {
  it('given an agent-page-owned account and a human actor with drive role MEMBER, should return manage false and grant false [0004 §8.16]', () => {
    const actual = decide(agentOwned({ humanDriveRole: 'MEMBER' }));
    expect({ manage: actual.manage, grant: actual.grant }).toEqual({ manage: false, grant: false });
  });

  it.each(['ADMIN', 'OWNER'] as const)('given drive role %s, should return manage true and grant true [0004 §8.16]', (role) => {
    const actual = decide(agentOwned({ humanDriveRole: role }));
    expect({ manage: actual.manage, grant: actual.grant, view: actual.view }).toEqual({ manage: true, grant: true, view: true });
  });

  it('given only the agent own drive membership (no human role), should never yield manage [0004 §8.16; B0 B-24]', () => {
    const actual = decide(agentOwned({ humanDriveRole: null }));
    expect(actual).toEqual(none);
  });

  it('given a user-owned account and a non-owner ADMIN of the agent drive, should return manage false', () => {
    const actual = decide(userOwned({ actorUserId: OTHER, actingHumanUserId: OTHER, humanDriveRole: 'ADMIN' }));
    expect({ manage: actual.manage, grant: actual.grant }).toEqual({ manage: false, grant: false });
  });
});

describe('session_http (default off; PR #2637 P1)', () => {
  it('given sessionHttpEnabled false, should return session_http false whatever else is true [0005 §10.18]', () => {
    const actual = decide(userOwned({ kind: 'session', sessionHttpEnabled: false })).session_http;
    expect(actual).toBe(false);
  });

  it('given sessionHttpEnabled true and use false, should return session_http false [0005 §10.18]', () => {
    const actual = decide(userOwned({ kind: 'session', sessionHttpEnabled: true, actingHumanUserId: OTHER })).session_http;
    expect(actual).toBe(false);
  });

  it('given sessionHttpEnabled true and use true, should return session_http true [0005 §10.18]', () => {
    const actual = decide(userOwned({ kind: 'session', sessionHttpEnabled: true })).session_http;
    expect(actual).toBe(true);
  });

  it('given sessionHttpEnabled true on a kind other than session, should return session_http false (the flag is meaningful only for sessions)', () => {
    const actual = decide(userOwned({ kind: 'api_key', sessionHttpEnabled: true })).session_http;
    expect(actual).toBe(false);
  });

  it('given AccountAccessLevel, should be a Record over every AccountPermission including session_http (typecheck fails on an added permission)', () => {
    const permissions: Record<AccountPermission, true> = { view: true, use: true, manage: true, grant: true, session_http: true };
    const level = decide(userOwned());
    const actual = (Object.keys(permissions) as AccountPermission[]).map((p) => typeof level[p]);
    expect(actual).toEqual(['boolean', 'boolean', 'boolean', 'boolean', 'boolean']);
  });
});

describe('view', () => {
  it('given an agent-page-owned account and a human who can edit the agent page, should return view true and use false', () => {
    const actual = decide(agentOwned({ humanDriveRole: 'MEMBER', humanCanEditAgentPage: true, agentPageId: 'page_other' as AgentPageId }));
    expect({ view: actual.view, use: actual.use }).toEqual({ view: true, use: false });
  });

  it('given a user-owned account viewed by its owner, should return view true; by anyone else, false', () => {
    const actual = [decide(userOwned()).view, decide(userOwned({ actorUserId: OTHER, actingHumanUserId: OTHER })).view];
    expect(actual).toEqual([true, false]);
  });

  it('given view true, should never expose a resolvable handle (type-level: AccountAccessLevel carries booleans only)', () => {
    const level = decide(userOwned());
    const actual = Object.values(level).every((value) => typeof value === 'boolean');
    expect(actual).toBe(true);
  });
});
