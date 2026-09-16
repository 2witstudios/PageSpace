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
import type { StoreIdentity, PlaneBindings, PolicyDigest, StoredSecretFacts, VerifiedGrant, WriteDigest } from '../store-adapter';
import { digestBindings } from '../digest-bindings';
import { decideResolve } from '../decide-resolve';

/** `decideResolve` with the caller's identity on the grant's own channel (G1c R8); a case that varies the identity passes one. */
const resolveWith = (input: Omit<Parameters<typeof decideResolve>[0], 'identity'> & { readonly identity?: StoreIdentity }) =>
  decideResolve({ identity: { tenantId: input.ref.tenantId, identityId: 'tenant-identity', channel: input.grant.aud, blastRadius: 'tenant' }, ...input });

const NOW = 1_800_000_000_000;
const ROTATION_GRACE_MS = 300_000;
const fakeHash = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const OPERATION: OperationRef = { class: 'read', name: 'github.repos.get' };

const BINDINGS: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  policyDigest: 'policy-digest-fixture' as PolicyDigest,
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
    pendingWrite: null,
    ...overrides,
  };
}

describe('decideResolve', () => {
  it('given stored null (wrong-tenant identity or absent), should return not_found', () => {
    const actual = resolveWith({ grant: makeGrant(), ref: REF, stored: null, now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given revokedAt set, should return revoked regardless of version', () => {
    const actual = resolveWith({
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
    const actual = resolveWith({
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
    const actual = resolveWith({
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
    const actual = resolveWith({
      grant: makeGrant({ credentialVersion: 3 as CredentialVersion, iat: NOW - 2_000 }),
      ref: REF,
      stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - 1_000 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: true });
  });

  it('given version one behind current outside rotationGraceMs, should return version_mismatch', () => {
    const actual = resolveWith({
      grant: makeGrant({ credentialVersion: 3 as CredentialVersion }),
      ref: REF,
      stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - ROTATION_GRACE_MS - 1 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'version_mismatch' });
  });

  // G1a review M7 (ADR 0005 §8 F3, the same rule as ADR 0004 F5a): grace is for a grant IN FLIGHT
  // across the rotation. One issued at or after `rotatedAt` never gets the old version.
  it('given a grant naming the previous version issued at or after rotatedAt, inside rotationGraceMs, should return version_mismatch', () => {
    const rotatedAt = NOW - 1_000;
    const actual = [rotatedAt, rotatedAt + 1].map((iat) =>
      resolveWith({
        grant: makeGrant({ credentialVersion: 3 as CredentialVersion, iat }),
        ref: REF,
        stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt }),
        now: NOW,
        rotationGraceMs: ROTATION_GRACE_MS,
        hash: fakeHash,
      }),
    );
    const expected = [{ ok: false, reason: 'version_mismatch' }, { ok: false, reason: 'version_mismatch' }];
    expect(actual).toEqual(expected);
  });

  // G1a review M7: the window is `now < rotatedAt + ROTATION_GRACE_MS` — the last admitted instant is
  // one ms before the boundary, and the boundary itself is outside.
  it('given a pre-rotation grant naming the previous version, should admit it one ms before rotatedAt + rotationGraceMs and refuse it at that instant', () => {
    const rotatedAt = NOW - ROTATION_GRACE_MS;
    const decideAt = (now: number) =>
      resolveWith({
        grant: makeGrant({ credentialVersion: 3 as CredentialVersion, iat: rotatedAt - 1 }),
        ref: REF,
        stored: makeStored({ currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt }),
        now,
        rotationGraceMs: ROTATION_GRACE_MS,
        hash: fakeHash,
      });
    const actual = { justInside: decideAt(NOW - 1), atBoundary: decideAt(NOW) };
    const expected = { justInside: { ok: true }, atBoundary: { ok: false, reason: 'version_mismatch' } };
    expect(actual).toEqual(expected);
  });

  // G1a review H1 (ADR 0005 §10.20): a main-DB writer can widen the approval policy, a resource
  // restriction or the bound agent pages while leaving `policyVersion` untouched; only the
  // `policyDigest` changes, and that alone must break the binding.
  it('given stored bindings whose policyDigest differs from the one the grant bindingDigest covers, with policyVersion unchanged, should return binding_mismatch', () => {
    const actual = resolveWith({
      grant: makeGrant(),
      ref: REF,
      stored: makeStored({ bindings: { ...BINDINGS, policyDigest: 'policy-digest-widened' as PolicyDigest } }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    const expected = { ok: false, reason: 'binding_mismatch' };
    expect(actual).toEqual(expected);
  });

  // Adversarial review of PR #2646: ADR 0005 §2.2 binds the grant's (tenantId, accountId, kind) to
  // the ref. The tenant and kind were never compared, and `revoked` was answered before the account
  // match — so a grant for account A learned whether account B was revoked.
  it('given a grant whose tenantId or accountKind differs from the ref, should return not_found', () => {
    const actual = [
      resolveWith({ grant: makeGrant({ tenantId: 'user:other' as TenantId }), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
      resolveWith({ grant: makeGrant({ accountKind: 'oauth2' }), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
    ];
    const expected = [
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a grant for another account and a revoked ref, should return not_found — never reveal the other account is revoked', () => {
    const actual = resolveWith({
      grant: makeGrant({ accountId: 'acct_other' as AccountId }),
      ref: REF,
      stored: makeStored({ revokedAt: NOW - 500 }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    const expected = { ok: false, reason: 'not_found' };
    expect(actual).toEqual(expected);
  });

  it('given stored bindings at a newer policyVersion than the grant bindingDigest was computed over, should return bindings_stale (G1c H2)', () => {
    const actual = resolveWith({
      grant: makeGrant(),
      ref: REF,
      stored: makeStored({ bindings: { ...BINDINGS, policyVersion: 2 as PolicyVersion } }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: false, reason: 'bindings_stale' });
  });

  it('given stored bindings with a changed ownerRef, should return binding_mismatch', () => {
    const actual = resolveWith({
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
    const actual = resolveWith({ grant: makeGrant(), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: true });
  });

  it('given resolveSessionOverHttp semantics: session by http-executor with sessionHttp false, should return kind_not_resolvable', () => {
    const actual = resolveWith({
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
    const actual = resolveWith({
      grant: makeGrant({ aud: 'http-executor', accountKind: 'session', sessionHttp: true }),
      ref: { ...REF, kind: 'session' },
      stored: makeStored({ kind: 'session' }),
      now: NOW,
      rotationGraceMs: ROTATION_GRACE_MS,
      hash: fakeHash,
    });
    expect(actual).toEqual({ ok: true });
  });

  // Codex review PR #2646 (P1, decide-resolve.ts:25): PlaneBindings and its digest carry no
  // accountId, so a verified grant for account A and a ref naming account B in the same tenant
  // with identical bindings/kind/version passed decideResolve. Pin that the grant must name the
  // SAME account as the ref, independent of whether the bindings happen to match.
  it('given a verified grant for account A and a ref naming a different account B with identical bindings/kind/version, should refuse (not ok, even though bindingDigest matches)', () => {
    const grantForAccountA = makeGrant({ accountId: 'acct_A' as AccountId });
    const refForAccountB = { tenantId: 'user:u1' as TenantId, accountId: 'acct_B' as AccountId, kind: 'api_key' as const };
    const storedForAccountB = makeStored(); // identical bindings/version to account A's — the confusable case
    const actual = resolveWith({ grant: grantForAccountA, ref: refForAccountB, stored: storedForAccountB, now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual.ok).toBe(false);
  });

  it('given a verified grant and a ref both naming the same account, should still return ok (the new check does not break the honest path)', () => {
    const actual = resolveWith({ grant: makeGrant({ accountId: 'acct_1' as AccountId }), ref: { ...REF, accountId: 'acct_1' as AccountId }, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: true });
  });
});

describe('decideResolve — G1c amendments', () => {
  const identityOn = (channel: StoreIdentity['channel']): StoreIdentity => ({ tenantId: REF.tenantId, identityId: 'tenant-identity', channel, blastRadius: 'tenant' });

  it('given an identity whose channel is not the grant audience, should return identity_refused (R8)', () => {
    const channels: readonly StoreIdentity['channel'][] = ['relay-runner', 'browser-worker', 'refresh-worker', 'ingress', 'manage'];
    const actual = channels.map((channel) => resolveWith({ grant: makeGrant(), identity: identityOn(channel), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }));
    expect(actual).toEqual(channels.map(() => ({ ok: false, reason: 'identity_refused' })));
  });

  it('given an identity on the grant audience, should resolve as before (R8)', () => {
    const actual = resolveWith({ grant: makeGrant(), identity: identityOn('http-executor'), ref: REF, stored: makeStored(), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash });
    expect(actual).toEqual({ ok: true });
  });

  it('given a reconcile-required ref (a pending write), should return store_unavailable — the ambiguous version is never served (E1)', () => {
    const pendingWrite = { version: 5 as CredentialVersion, digest: 'write-digest' as WriteDigest, rotation: false };
    const actual = [
      resolveWith({ grant: makeGrant(), ref: REF, stored: makeStored({ pendingWrite }), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
      resolveWith({ grant: makeGrant({ credentialVersion: 5 as CredentialVersion }), ref: REF, stored: makeStored({ pendingWrite }), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
    ];
    expect(actual).toEqual([
      { ok: false, reason: 'store_unavailable' },
      { ok: false, reason: 'store_unavailable' },
    ]);
  });

  it('given a grant signed under an older policyVersion than the stored bindings, should return bindings_stale; at the same epoch with other bindings, binding_mismatch (H2)', () => {
    const newer = { ...BINDINGS, policyVersion: 2 as PolicyVersion };
    const actual = [
      resolveWith({ grant: makeGrant(), ref: REF, stored: makeStored({ bindings: newer }), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
      resolveWith({ grant: makeGrant({ policyVersion: 2 as PolicyVersion }), ref: REF, stored: makeStored({ bindings: newer }), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
      resolveWith({ grant: makeGrant({ policyVersion: 3 as PolicyVersion }), ref: REF, stored: makeStored({ bindings: newer }), now: NOW, rotationGraceMs: ROTATION_GRACE_MS, hash: fakeHash }),
    ];
    expect(actual).toEqual([
      { ok: false, reason: 'bindings_stale' },
      { ok: false, reason: 'binding_mismatch' },
      { ok: false, reason: 'binding_mismatch' },
    ]);
  });
});
