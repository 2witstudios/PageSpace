import { describe, it } from 'vitest';

// ADR 0004 §4 + §8.14–16 — RED at G1b before decide-account-access.ts exists.

describe('decideAccountAccess — what never grants anything (ADR 0004 §4.2)', () => {
  it.todo('given every page permission true and no account relationship, should return view/use/manage/grant/session_http all false [0004 §8.14]');
  it.todo('given drive membership, workspace ownership and conversation access with no account relationship, should return all false');
});

describe('use', () => {
  it.todo('given a user-owned account and an acting human who is not the owner (a shared agent invoked by another member), should return use false even when the agent page is bound [0004 §8.15]');
  it.todo('given a user-owned account, the owner as acting human, and a bound agent page, should return use true');
  it.todo('given an agent-page-owned account whose drive the caller ceiling does not admit, should return use false (ceiling first)');
  it.todo('given an unattended run with no delegation fact, should return use false');
});

describe('manage and grant', () => {
  it.todo('given an agent-page-owned account and a human actor with drive role MEMBER, should return manage false and grant false [0004 §8.16]');
  it.todo('given drive role ADMIN, should return manage true and grant true [0004 §8.16]');
  it.todo('given only the agent own drive membership (no human role), should never yield manage [0004 §8.16; B0 B-24]');
  it.todo('given a user-owned account and a non-owner ADMIN of the agent drive, should return manage false');
});

describe('session_http (default off; PR #2637 P1)', () => {
  it.todo('given a change to sessionHttpEnabled in either direction, should be in the policyVersion bump list so outstanding sessionHttp grants die (policy-bump classifier table test) [0004 §4.4, §8.32; G1a review M4]');
  it.todo('given sessionHttpEnabled false, should return session_http false whatever else is true [0005 §10.18]');
  it.todo('given sessionHttpEnabled true and use false, should return session_http false [0005 §10.18]');
  it.todo('given sessionHttpEnabled true and use true, should return session_http true [0005 §10.18]');
  it.todo('given AccountAccessLevel, should be a Record over every AccountPermission including session_http (typecheck fails on an added permission)');
});

describe('view', () => {
  it.todo('given an agent-page-owned account and a human who can edit the agent page, should return view true and use false');
  it.todo('given view true, should never expose a resolvable handle (type-level: AccountAccessLevel carries booleans only)');
});
