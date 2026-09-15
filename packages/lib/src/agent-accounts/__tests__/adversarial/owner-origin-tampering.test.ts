import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { AccountId, AccountOwnerRef, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { HashBytes } from '../../grant';
import type { PlaneBindings, StoredSecretFacts, VerifiedGrant } from '../../store/store-adapter';
import { digestBindings } from '../../store/digest-bindings';
import { decideResolve } from '../../store/decide-resolve';

// Threat model A9 (ASI03/ASI10). A main-DB writer who reassigns owner/origins/approval rows
// must not broaden authority. G1b-store owns the plane-bindings-at-resolve rows below (no
// main-DB fact is consulted — decideResolve compares digestBindings(stored) against the
// grant's signed bindingDigest only); approval-outcome and policy-epoch enforcement live in
// G1a's approval/grant-verification modules, not the store, and are left as it.todo here.

const hash: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = 1_800_000_000_000;
const BINDINGS: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  kind: 'api_key',
};
const REF = { tenantId: 'user:u1' as TenantId, accountId: 'acct_1' as AccountId, kind: 'api_key' as const };

function grantOverBindings(bindings: PlaneBindings, overrides: Partial<VerifiedGrant> = {}): VerifiedGrant {
  return {
    aud: 'http-executor',
    credentialVersion: 4 as CredentialVersion,
    bindingDigest: digestBindings({ bindings, hash }),
    sessionHttp: false,
    ...overrides,
  } as VerifiedGrant;
}

function stored(overrides: Partial<StoredSecretFacts> = {}): StoredSecretFacts {
  return { kind: 'api_key', currentVersion: 4 as CredentialVersion, previousVersion: 3 as CredentialVersion, rotatedAt: NOW - 1_000, revokedAt: null, bindings: BINDINGS, ...overrides };
}

describe('adversarial: owner-origin-tampering', () => {
  it('given agent_accounts.ownerUserId reassigned after put and a grant signed over the tampered row, should return binding_mismatch at resolve (grant.bindingDigest differs from digestBindings(stored))', () => {
    // The grant was signed over the TAMPERED bindings (attacker's reassignment); the plane's
    // stored copy is still the original — digests disagree, so this is binding_mismatch either
    // direction the tamper runs. Modelled here as the attacker's grant vs. the honest stored row.
    const tamperedBindings: PlaneBindings = { ...BINDINGS, ownerRef: { kind: 'user', userId: 'attacker' } };
    const grantSignedOverTamperedRow = grantOverBindings(tamperedBindings);
    const actual = decideResolve({ grant: grantSignedOverTamperedRow, ref: REF, stored: stored({ bindings: BINDINGS }), now: NOW, rotationGraceMs: 300_000, hash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given allowedOrigins widened in the main DB without step-up, should return binding_mismatch at resolve (no main-DB fact consulted by the plane)', () => {
    const honestGrant = grantOverBindings(BINDINGS);
    const widenedStoredBindings: PlaneBindings = { ...BINDINGS, allowedOrigins: [...BINDINGS.allowedOrigins, 'https://attacker.example' as CanonicalOrigin] };
    const actual = decideResolve({ grant: honestGrant, ref: REF, stored: stored({ bindings: widenedStoredBindings }), now: NOW, rotationGraceMs: 300_000, hash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it.todo('given approval row outcome flipped to always in the DB, should still refuse irreversible/privilege classes (class_never_always) — I/O row, owned by G1a (approval.ts / decide-approval.ts), not the store');

  it('given policyVersion bumped by an owner change, should refuse every outstanding grant (the old grant\'s bindingDigest was computed over the old policyVersion, so it now mismatches the stored row)', () => {
    const grantOverOldPolicy = grantOverBindings(BINDINGS);
    const bumpedPolicyBindings: PlaneBindings = { ...BINDINGS, policyVersion: 2 as PolicyVersion };
    const actual = decideResolve({ grant: grantOverOldPolicy, ref: REF, stored: stored({ bindings: bumpedPolicyBindings }), now: NOW, rotationGraceMs: 300_000, hash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given a widening performed through put with step-up (bindings rewritten and re-committed), a grant signed over the NEW bindings should resolve', () => {
    const widenedBindings: PlaneBindings = { ...BINDINGS, allowedOrigins: [...BINDINGS.allowedOrigins, 'https://new-origin.example' as CanonicalOrigin] };
    const grantOverNewBindings = grantOverBindings(widenedBindings);
    const actual = decideResolve({ grant: grantOverNewBindings, ref: REF, stored: stored({ bindings: widenedBindings }), now: NOW, rotationGraceMs: 300_000, hash });
    expect(actual).toEqual({ ok: true });
  });
});
