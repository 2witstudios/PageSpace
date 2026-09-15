/**
 * ADR 0005 §8 F1-F5, F10; §10.3-5 — RED at G1b-store before `decide-resolve.ts` existed.
 * Composes `decideResolveCaller` (F1/F2) and `decidePlaneBinding` (F4); this
 * file owns the version/rotation-grace (F3) and revoked/not_found (F5, F10) rules.
 */
import { describe, it, expect } from 'vitest';
import type {
  AccountId,
  AccountOwnerRef,
  CredentialVersion,
  PolicyVersion,
  TenantId,
} from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type {
  AgentAccountGrant,
  ApprovalId,
  BindingDigest,
  ConversationId,
  GrantId,
  GrantIssuer,
  Nonce,
  OperationRef,
  PresenterChannel,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../../grant';
import type { PlaneBindings, StoredSecretFacts, VerifiedGrant } from '../store-adapter';
import { digestBindings } from '../digest-bindings';
import { decideResolve } from '../decide-resolve';

const NOW = 1_800_000_000_000;
const ROTATION_GRACE_MS = 300_000;
const fakeHash = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const OPERATION: OperationRef = { class: 'read', name: 'github.repos.get' };

const BINDINGS: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  kind: 'api_key',
};

const CURRENT_DIGEST = digestBindings({ bindings: BINDINGS, hash: fakeHash });

function makeGrant(overrides: Partial<AgentAccountGrant> = {}): VerifiedGrant {
  const aud: PresenterChannel = overrides.aud ?? 'http-executor';
  const grant: AgentAccountGrant = {
    grantId: 'grant_1' as GrantId,
    iss: 'pagespace-account-authority' as GrantIssuer,
    aud,
    tenantId: 'user:u1' as TenantId,
    human: { userId: 'u1' as UserId, sessionId: 'session_1' as SessionId },
    delegationId: null,
    agentPageId: null,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'acct_1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 4 as CredentialVersion,
    policyVersion: 1 as PolicyVersion,
    bindingDigest: CURRENT_DIGEST,
    operation: OPERATION,
    requestDigest: 'req_digest_1' as RequestDigest,
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
    nonce: 'nonce_1' as Nonce,
    presenter: { keyId: 'pk_1' as PresenterKeyId, channel: aud },
    ...overrides,
  };
  return grant as VerifiedGrant;
}

const REF = { tenantId: 'user:u1' as TenantId, accountId: 'acct_1' as AccountId, kind: 'api_key' as const };

function makeStored(overrides: Partial<StoredSecretFacts> = {}): StoredSecretFacts {
  return {
    kind: 'api_key',
    currentVersion: 4 as CredentialVersion,
    previousVersion: 3 as CredentialVersion,
    rotatedAt: NOW - 1_000,
    revokedAt: null,
    bindings: BINDINGS,
    ...overrides,
  };
}

describe('decideResolve', () => {
  it('given stored null (wrong-tenant identity or absent), should return not_found', () => {
    const actual = decideResolve({ grant: makeGrant(), ref: REF, stored: null, now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given revokedAt set, should return revoked regardless of version', () => {
    const actual = decideResolve({
      grant: makeGrant(),
      ref: REF,
      stored: makeStored({ revokedAt: NOW - 500 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given kind password and channel http-executor, should return kind_not_resolvable', () => {
    const actual = decideResolve({
      grant: makeGrant({ aud: 'http-executor', accountKind: 'password' }),
      ref: { ...REF, kind: 'password' },
      stored: makeStored({ kind: 'password' }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind password and channel browser-worker, should return ok', () => {
    const actual = decideResolve({
      grant: makeGrant({ aud: 'browser-worker', accountKind: 'password' }),
      ref: { ...REF, kind: 'password' },
      stored: makeStored({ kind: 'password' }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: true });
  });

  it('given version one behind current inside rotationGraceMs, should return ok for a grant that named the old version', () => {
    const actual = decideResolve({
      grant: makeGrant({ credentialVersion: 3 as CredentialVersion }),
      ref: REF,
      stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - 1_000 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: true });
  });

  it('given version one behind current outside rotationGraceMs, should return version_mismatch', () => {
    const actual = decideResolve({
      grant: makeGrant({ credentialVersion: 3 as CredentialVersion }),
      ref: REF,
      stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - ROTATION_GRACE_MS - 1 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'version_mismatch' });
  });

  it('given stored bindings whose policyVersion differs from those the grant bindingDigest was computed over, should return binding_mismatch', () => {
    const actual = decideResolve({
      grant: makeGrant(),
      ref: REF,
      stored: makeStored({ bindings: { ...BINDINGS, policyVersion: 2 as PolicyVersion } }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given stored bindings with a changed ownerRef, should return binding_mismatch', () => {
    const actual = decideResolve({
      grant: makeGrant(),
      ref: REF,
      stored: makeStored({ bindings: { ...BINDINGS, ownerRef: { kind: 'user', userId: 'attacker' } } }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given consistent version and bindings, should return ok', () => {
    const actual = decideResolve({ grant: makeGrant(), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: true });
  });

  it('given resolveSessionOverHttp semantics: session by http-executor with sessionHttp false, should return kind_not_resolvable', () => {
    const actual = decideResolve({
      grant: makeGrant({ aud: 'http-executor', accountKind: 'session', sessionHttp: false }),
      ref: { ...REF, kind: 'session' },
      stored: makeStored({ kind: 'session' }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given resolveSessionOverHttp semantics: session by http-executor with sessionHttp true, should return ok', () => {
    const actual = decideResolve({
      grant: makeGrant({ aud: 'http-executor', accountKind: 'session', sessionHttp: true }),
      ref: { ...REF, kind: 'session' },
      stored: makeStored({ kind: 'session' }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: true });
  });
});
