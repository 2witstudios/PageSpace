/**
 * L2·G2 — `expectedBindingFor`: the facts the HTTP executor hands the grant
 * verifier, assembled from THREE sources it does not merge by trust:
 * - the run envelope (the principals of the run the web process is serving);
 * - the main-DB row (status, drive, current policy version — each compared
 *   as a fact against the signed grant, never trusted as plane state);
 * - the PLANE's own record (current/previous credential version, rotation
 *   time, revocation — plane-attested, G1c R3/M7).
 * A revocation the plane records wins over a main-DB row that still says
 * active; an account either side does not know is an `UnknownAccountBinding`
 * (the verifier answers `version_mismatch`, not an existence oracle).
 */
import { describe, expect, it } from 'vitest';
import type { AgentAccountRecord, CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ConversationId, PresenterKeyId, RunId, SessionId, UserId } from '../../grant';
import { expectedBindingFor } from '../expected-binding-for';

const row = { id: 'acct_1', kind: 'api_key', status: 'active', ownerDriveId: 'drive_1', tenantId: 'drive:drive_1', policyVersion: 4 } as unknown as AgentAccountRecord;
const run = { human: { userId: 'u1' as UserId, sessionId: 's1' as SessionId }, agentPageId: 'page_a' as AgentPageId, conversationId: 'c1' as ConversationId, runId: 'r1' as RunId };
const plane = { version: 3 as CredentialVersion, previousVersion: 2 as CredentialVersion, rotatedAt: 1_000, revokedAt: null };
const presenter = { keyId: 'exec_1' as PresenterKeyId, channel: 'http-executor' as const };

describe('expectedBindingFor', () => {
  it('given a known account, should combine the run principals, the row facts and the plane-attested versions', () => {
    const actual = expectedBindingFor({ run, presenter, row, plane, allowedDriveIds: [] });
    const expected = {
      aud: 'http-executor',
      presenter,
      human: run.human,
      agentPageId: 'page_a',
      conversationId: 'c1',
      runId: 'r1',
      tenantId: 'drive:drive_1',
      delegation: { kind: 'live_session' },
      sandbox: null,
      ceilingAdmitsAccount: true,
      accountId: 'acct_1',
      accountKind: 'api_key',
      accountStatus: 'active',
      accountDriveId: 'drive_1',
      currentCredentialVersion: 3,
      previousCredentialVersion: 2,
      rotatedAt: 1_000,
      currentPolicyVersion: 4,
    };
    expect(actual).toEqual(expected);
  });

  it('given the plane records a revocation the main-DB row does not, should report the account revoked', () => {
    const actual = expectedBindingFor({ run, presenter, row, plane: { ...plane, revokedAt: 5_000 }, allowedDriveIds: [] }).accountStatus;
    const expected = 'revoked';
    expect(actual).toEqual(expected);
  });

  it('given no row or no plane record, should be an unknown account binding', () => {
    const actual = [expectedBindingFor({ run, presenter, row: null, plane, allowedDriveIds: [] }), expectedBindingFor({ run, presenter, row, plane: null, allowedDriveIds: [] })].map((binding) => [binding.accountId, binding.currentCredentialVersion, binding.accountStatus]);
    const expected = [
      [null, null, null],
      [null, null, null],
    ];
    expect(actual).toEqual(expected);
  });

  it('given an unattended run (no session), should carry no live-session delegation fact', () => {
    const actual = expectedBindingFor({ run: { ...run, human: { ...run.human, sessionId: null } }, presenter, row, plane, allowedDriveIds: [] }).delegation;
    const expected = { kind: 'none' };
    expect(actual).toEqual(expected);
  });

  it('given a caller ceiling that excludes the account drive, should report the ceiling does not admit it', () => {
    const actual = expectedBindingFor({ run, presenter, row, plane, allowedDriveIds: ['drive_other'] }).ceilingAdmitsAccount;
    const expected = false;
    expect(actual).toEqual(expected);
  });
});
