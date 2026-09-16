import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { AccountId, AccountOwnerRef, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { HashBytes } from '../../grant';
import type { PlaneBindings, PolicyDigest, StoredSecretFacts, VerifiedGrant } from '../../store/store-adapter';
import { digestBindings } from '../../store/digest-bindings';
import { decideResolve } from '../../store/decide-resolve';
import { decideResolveCaller } from '../../store/decide-resolve-caller';

// Threat model A8, Λ8 (ASI03). Revocation ends live use.
// G1b-store owns the store-side rows below (decideResolve / decideResolveCaller); the live
// browser pane and account-status rows are G6b's (no browser worker exists yet — left as it.todo).

const hash: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = 1_800_000_000_000;
const BINDINGS: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  policyDigest: 'policy-digest-fixture' as PolicyDigest,
  kind: 'api_key',
};
const REF = { tenantId: 'user:u1' as TenantId, accountId: 'acct_1' as AccountId, kind: 'api_key' as const };

function grant(overrides: Partial<VerifiedGrant> = {}): VerifiedGrant {
  return {
    aud: 'http-executor',
    accountId: REF.accountId,
    tenantId: REF.tenantId,
    accountKind: REF.kind,
    credentialVersion: 4 as CredentialVersion,
    bindingDigest: digestBindings({ bindings: BINDINGS, hash }),
    sessionHttp: false,
    ...overrides,
  } as VerifiedGrant;
}

function stored(overrides: Partial<StoredSecretFacts> = {}): StoredSecretFacts {
  return { kind: 'api_key', currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - 1_000, revokedAt: null, bindings: BINDINGS, ...overrides };
}

describe('adversarial: mid-session-revocation', () => {
  it('given revoke during an in-flight grant, should refuse the next resolve with revoked regardless of version', () => {
    const actual = decideResolve({ grant: grant(), ref: REF, stored: stored({ revokedAt: NOW - 500 }), now: NOW, rotationGraceMs: 300_000, hash });
    expect(actual).toEqual({ ok: false, reason: 'revoked' });
  });

  it.todo(
    'given revoke during a live browser session, should end the pane within the cookie window and refuse every further typed action — I/O row, owned by G6b (live pane) — no browser worker exists yet',
  );

  it.todo('given delete with upstream revocation failed, should report removed:true, upstream:failed — see store-adapter-infisical.integration.test.ts for upstream:unsupported; failed is provider-dependent I/O, exercised once a real provider (not synthetic Infisical material) is wired at L2/L3');

  it.todo('given account status needs_reauth, should refuse issuance and require human re-login — account-row/status is agent_accounts (G2 schema), not the store; owned by G2');

  it('given a session account with sessionHttpEnabled false (grant.sessionHttp false), should be unresolvable by the http-executor under any ordinary use grant (session_http default off)', () => {
    expect(decideResolveCaller({ aud: 'http-executor', kind: 'session', sessionHttp: false })).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it.todo('given an unexpired grant issued while the account was active and the account then marked revoked, needs_reauth or deleted, should return account_not_active at verifyGrant — before the plane is ever asked [0004 F5; G1a review H4] — the pure verifier row is grant.test.ts §8.28; the end-to-end revoke is— I/O row, owned by G1b-store (store revoke) and G6b (live pane)');

  it.todo("given an unexpired grant with sessionHttp true and the account's sessionHttpEnabled then turned off, should return policy_epoch at verifyGrant and binding_mismatch at resolve — the flag change bumps policyVersion [0004 §8.32; G1a review M4] — the bump is written by the account write path (G2) through rebind (G1b-store)");
});
