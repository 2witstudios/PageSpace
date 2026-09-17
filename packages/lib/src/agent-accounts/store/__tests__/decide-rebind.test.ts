/**
 * ADR 0005 §2.2 `rebind`, §2.6, §10.21, §10.26–27 (G1a review H2; G1c R2, E2,
 * R13). Rewritten RED at G1c before `decide-rebind.ts` implemented pinned
 * consenters, ref-bound single-use consent and consent-free narrowing.
 * One row per refusal, each changing exactly one fact from an otherwise valid
 * rebind.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { AccountId, AccountOwnerRef, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { ConsentId, Ed25519Verify, HashBytes, UserId } from '../../grant';
import type { OwnerConsent, PlaneBindings, PlaneBindingsRecord, PlaneConsenters, PlaneScope, SecretRef } from '../store-adapter';
import { canonicalJson } from '../../canonical-json';
import { digestBindings } from '../digest-bindings';
import { digestPlaneScope } from '../digest-plane-scope';
import { decideRebind } from '../decide-rebind';

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 300_000;
const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');

const consentKey = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');
const CONSENT_PUBLIC_KEY = new Uint8Array(consentKey.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

const API = 'https://api.example:443' as CanonicalOrigin;
const UPLOADS = 'https://uploads.example:443' as CanonicalOrigin;

const SCOPE: PlaneScope = {
  approvalPolicy: null,
  resourceRestrictions: {},
  boundAgentPageIds: [],
  allowedOrigins: [API],
  auxiliaryOrigins: [],
  sessionHttpEnabled: false,
  providerSlug: null,
};

function record(input: { scope: PlaneScope; policyVersion: number; ownerRef?: AccountOwnerRef; tenantId?: string; consenters?: PlaneConsenters }): PlaneBindingsRecord {
  const ownerRef = input.ownerRef ?? { kind: 'user', userId: 'owner' };
  const bindings: PlaneBindings = {
    tenantId: (input.tenantId ?? (ownerRef.kind === 'user' ? `user:${ownerRef.userId}` : `drive:${ownerRef.driveId}`)) as TenantId,
    ownerRef,
    allowedOrigins: input.scope.allowedOrigins,
    policyVersion: input.policyVersion as PolicyVersion,
    policyDigest: digestPlaneScope({ scope: input.scope, hash: sha3 }),
    kind: 'api_key',
  };
  return { bindings, scope: input.scope, consenters: input.consenters ?? { kind: 'owner' } };
}

const REF: SecretRef = { tenantId: 'user:owner' as TenantId, accountId: 'acct_1' as AccountId, kind: 'api_key' };
const STORED = record({ scope: SCOPE, policyVersion: 3 });
const WIDER = record({ scope: { ...SCOPE, allowedOrigins: [API, UPLOADS] }, policyVersion: 4 });
const SAME_SCOPE_BUMP = record({ scope: SCOPE, policyVersion: 4 });

type UnsignedConsent = Omit<OwnerConsent, 'signature'>;

function signConsent(fields: UnsignedConsent, privateKey = consentKey.privateKey): OwnerConsent {
  const message = new TextEncoder().encode(canonicalJson(fields));
  return { ...fields, signature: nodeSign(null, message, privateKey).toString('base64') };
}

function consentFor(next: PlaneBindingsRecord, overrides: Partial<UnsignedConsent> = {}, privateKey = consentKey.privateKey): OwnerConsent {
  return signConsent(
    {
      consentId: 'consent_1' as ConsentId,
      consentingUserId: 'owner' as UserId,
      stepUpChallengeId: 'challenge_1',
      ref: REF,
      bindingsDigest: digestBindings({ bindings: next.bindings, hash: sha3 }),
      consenters: next.consenters,
      issuedAt: NOW - 1_000,
      ...overrides,
    },
    privateKey,
  );
}

function decide(overrides: Partial<Parameters<typeof decideRebind>[0]> = {}) {
  const next = overrides.next ?? WIDER;
  return decideRebind({
    ref: REF,
    stored: STORED,
    expectedVersion: 3 as PolicyVersion,
    next,
    consent: consentFor(next),
    consentPublicKey: CONSENT_PUBLIC_KEY,
    now: NOW,
    maxAgeMs: MAX_AGE_MS,
    verify,
    hash: sha3,
    ...overrides,
  });
}

const REBIND_WITH_CONSENT = { outcome: 'rebind', consumeConsentId: 'consent_1' };
const refuse = (reason: string) => ({ outcome: 'refuse', reason });

describe('decideRebind — as before', () => {
  it('given a widening with a fresh consent from the stored owner, for this ref, signed under the pinned key over exactly next, should rebind and name the consent to consume', () => {
    const actual = decide();
    expect(actual).toEqual(REBIND_WITH_CONSENT);
  });

  it('given stored null, should return not_found', () => {
    const actual = decide({ stored: null });
    expect(actual).toEqual(refuse('not_found'));
  });

  it('given a consent whose bindingsDigest covers any other bindings than next, should return consent_invalid', () => {
    const other = record({ scope: { ...SCOPE, allowedOrigins: [API, UPLOADS, 'https://attacker.example:443' as CanonicalOrigin] }, policyVersion: 4 });
    const actual = [decide({ consent: consentFor(other) }), decide({ next: other, consent: consentFor(WIDER) })];
    expect(actual).toEqual([refuse('consent_invalid'), refuse('consent_invalid')]);
  });

  it('given a consent signed by any key but the pinned consent key, a signature that is not base64, or a signed field altered after signing, should return consent_invalid', () => {
    const actual = [
      decide({ consent: consentFor(WIDER, {}, otherKey.privateKey) }),
      decide({ consent: { ...consentFor(WIDER), signature: 'not base64!' } }),
      decide({ consent: { ...consentFor(WIDER), stepUpChallengeId: 'challenge_other' } }),
    ];
    expect(actual).toEqual([refuse('consent_invalid'), refuse('consent_invalid'), refuse('consent_invalid')]);
  });

  it('given a consent issued more than rebindConsentMaxAgeMs ago, or in the future, should return consent_invalid; exactly maxAgeMs old should still rebind', () => {
    const actual = [
      decide({ consent: consentFor(WIDER, { issuedAt: NOW - MAX_AGE_MS - 1 }) }),
      decide({ consent: consentFor(WIDER, { issuedAt: NOW + 1 }) }),
      decide({ consent: consentFor(WIDER, { issuedAt: NOW - MAX_AGE_MS }) }),
    ];
    expect(actual).toEqual([refuse('consent_invalid'), refuse('consent_invalid'), REBIND_WITH_CONSENT]);
  });

  it('given a user-owned account and a consent from anyone but the STORED owner, should return consent_invalid', () => {
    const actual = decide({ consent: consentFor(WIDER, { consentingUserId: 'attacker' as UserId }) });
    expect(actual).toEqual(refuse('consent_invalid'));
  });

  it('given stored policyVersion !== expectedVersion, or next.policyVersion not strictly greater, should return version_conflict', () => {
    const sameVersion = record({ scope: WIDER.scope, policyVersion: 3 });
    const actual = [decide({ expectedVersion: 2 as PolicyVersion }), decide({ next: sameVersion })];
    expect(actual).toEqual([refuse('version_conflict'), refuse('version_conflict')]);
  });

  it('given next bindings changing tenantId or kind, even with a valid consent to them, should return immutable_binding_changed', () => {
    const otherTenant = record({ scope: WIDER.scope, policyVersion: 4, tenantId: 'user:elsewhere' });
    const otherKind: PlaneBindingsRecord = { ...WIDER, bindings: { ...WIDER.bindings, kind: 'oauth2' } };
    const actual = [otherTenant, otherKind].map((next) => decide({ next }));
    expect(actual).toEqual([refuse('immutable_binding_changed'), refuse('immutable_binding_changed')]);
  });
});

describe('decideRebind — the owner kind is immutable and consenters are pinned (G1c R2)', () => {
  const PAGE_OWNER: AccountOwnerRef = { kind: 'agent_page', agentPageId: 'page_1', driveId: 'drive_1' };
  const PAGE_REF: SecretRef = { ...REF, tenantId: 'drive:drive_1' as TenantId };
  const PINNED: PlaneConsenters = { kind: 'pinned', userIds: ['admin_a' as UserId] };
  const PAGE_STORED = record({ scope: SCOPE, policyVersion: 3, ownerRef: PAGE_OWNER, consenters: PINNED });
  const PAGE_WIDER = record({ scope: WIDER.scope, policyVersion: 4, ownerRef: PAGE_OWNER, consenters: PINNED });
  const decidePage = (next: PlaneBindingsRecord, consent: OwnerConsent | null) => decide({ ref: PAGE_REF, stored: PAGE_STORED, next, consent });
  const pageConsent = (next: PlaneBindingsRecord, consentingUserId: string) => consentFor(next, { ref: PAGE_REF, consentingUserId: consentingUserId as UserId });

  it('given an ownerRef kind change, should return immutable_binding_changed even with a valid owner consent', () => {
    const toPage = record({ scope: WIDER.scope, policyVersion: 4, ownerRef: { kind: 'agent_page', agentPageId: 'page_1', driveId: 'x' }, tenantId: 'user:owner', consenters: PINNED });
    const actual = decide({ next: toPage });
    expect(actual).toEqual(refuse('immutable_binding_changed'));
  });

  it('given a user owner rewritten to another user (the tenant would no longer derive from the owner), should return immutable_binding_changed', () => {
    const hijacked = record({ scope: WIDER.scope, policyVersion: 4, ownerRef: { kind: 'user', userId: 'attacker' }, tenantId: 'user:owner' });
    const actual = decide({ next: hijacked, consent: consentFor(hijacked, { consentingUserId: 'attacker' as UserId }) });
    expect(actual).toEqual(refuse('immutable_binding_changed'));
  });

  it('given an agent-page-owned account, should accept a consent from a PINNED consenter only — a main-DB drive ADMIN who is not pinned gets consent_invalid', () => {
    const actual = [decidePage(PAGE_WIDER, pageConsent(PAGE_WIDER, 'admin_a')), decidePage(PAGE_WIDER, pageConsent(PAGE_WIDER, 'admin_b'))];
    expect(actual).toEqual([REBIND_WITH_CONSENT, refuse('consent_invalid')]);
  });

  it('given a change of the pinned set, should need a CURRENT pinned consenter — a user only in the next set cannot consent to adding themselves', () => {
    const handedOver = record({ scope: SCOPE, policyVersion: 4, ownerRef: PAGE_OWNER, consenters: { kind: 'pinned', userIds: ['admin_b' as UserId] } });
    const actual = [decidePage(handedOver, pageConsent(handedOver, 'admin_a')), decidePage(handedOver, pageConsent(handedOver, 'admin_b')), decidePage(handedOver, null)];
    expect(actual).toEqual([REBIND_WITH_CONSENT, refuse('consent_invalid'), refuse('consent_required')]);
  });

  it('given the owner agent page moved within the same drive (tenant unchanged) and no consent, should return consent_required — an owner change is never a narrowing', () => {
    const moved = record({ scope: SCOPE, policyVersion: 4, ownerRef: { ...PAGE_OWNER, agentPageId: 'page_2' }, consenters: PINNED });
    const actual = [decidePage(moved, null), decidePage(moved, pageConsent(moved, 'admin_a'))];
    expect(actual).toEqual([refuse('consent_required'), REBIND_WITH_CONSENT]);
  });

  it('given a consent whose consenters differ from next, should return consent_invalid', () => {
    const actual = decidePage(PAGE_WIDER, consentFor(PAGE_WIDER, { ref: PAGE_REF, consentingUserId: 'admin_a' as UserId, consenters: { kind: 'pinned', userIds: ['admin_a' as UserId, 'admin_c' as UserId] } }));
    expect(actual).toEqual(refuse('consent_invalid'));
  });

  it('given consenters that do not fit the owner kind (pinned for a user owner, owner or an empty set for an agent page), should return consent_invalid', () => {
    const userWithPinned: PlaneBindingsRecord = { ...WIDER, consenters: PINNED };
    const pageWithOwner: PlaneBindingsRecord = { ...PAGE_WIDER, consenters: { kind: 'owner' } };
    const pageWithNone: PlaneBindingsRecord = { ...PAGE_WIDER, consenters: { kind: 'pinned', userIds: [] } };
    const actual = [
      decide({ next: userWithPinned, consent: consentFor(userWithPinned) }),
      decidePage(pageWithOwner, pageConsent(pageWithOwner, 'admin_a')),
      decidePage(pageWithNone, pageConsent(pageWithNone, 'admin_a')),
    ];
    expect(actual).toEqual([refuse('consent_invalid'), refuse('consent_invalid'), refuse('consent_invalid')]);
  });
});

describe('decideRebind — consent names the ref (G1c E2)', () => {
  it('given a consent recorded for another account or tenant, should return consent_invalid — identical bindings do not make it transferable', () => {
    const actual = [
      decide({ consent: consentFor(WIDER, { ref: { ...REF, accountId: 'acct_2' as AccountId } }) }),
      decide({ consent: consentFor(WIDER, { ref: { ...REF, kind: 'bearer' } }) }),
      decide({ ref: { ...REF, accountId: 'acct_2' as AccountId } }),
    ];
    expect(actual).toEqual([refuse('consent_invalid'), refuse('consent_invalid'), refuse('consent_invalid')]);
  });
});

describe('decideRebind — narrowing needs no consent (G1c R13)', () => {
  it('given an equal scope with a bumped policyVersion and no consent, should rebind with nothing to consume', () => {
    const actual = decide({ next: SAME_SCOPE_BUMP, consent: null });
    expect(actual).toEqual({ outcome: 'rebind', consumeConsentId: null });
  });

  it('given a strictly narrower scope and no consent, should rebind with nothing to consume', () => {
    const storedWide = record({ scope: WIDER.scope, policyVersion: 3 });
    const narrower = record({ scope: SCOPE, policyVersion: 4 });
    const actual = decide({ stored: storedWide, next: narrower, consent: null });
    expect(actual).toEqual({ outcome: 'rebind', consumeConsentId: null });
  });

  it('given a widening and no consent, should return consent_required', () => {
    const actual = decide({ consent: null });
    expect(actual).toEqual(refuse('consent_required'));
  });

  it('given a narrowing that still carries a consent, should verify it (an invalid consent is never ignored) and consume a valid one', () => {
    const actual = [decide({ next: SAME_SCOPE_BUMP, consent: consentFor(SAME_SCOPE_BUMP, { consentingUserId: 'attacker' as UserId }) }), decide({ next: SAME_SCOPE_BUMP, consent: consentFor(SAME_SCOPE_BUMP) })];
    expect(actual).toEqual([refuse('consent_invalid'), REBIND_WITH_CONSENT]);
  });

  it('given a next scope that does not match its own policyDigest (a narrow scope claimed over wide bindings), should refuse version_conflict and never treat it as narrowing', () => {
    const lying: PlaneBindingsRecord = { ...WIDER, scope: SCOPE };
    const actual = [decide({ next: lying, consent: null }), decide({ next: lying })];
    expect(actual).toEqual([refuse('version_conflict'), refuse('version_conflict')]);
  });

  it('given a next scope whose policy limits are not numbers (a widening dressed as narrowing), should refuse version_conflict even with no consent (G1c review HIGH)', () => {
    const bogus = record({ scope: { ...SCOPE, approvalPolicy: { scope: { origins: [API], operations: [], resources: [] }, trigger: 'every_use', duration: null, limits: { maxUsesPerHour: 'x' as unknown as number, maxBytesOut: 1, maxConcurrent: 1 }, approver: 'owner' as UserId } }, policyVersion: 4 });
    const actual = [decide({ next: bogus, consent: null }), decide({ next: bogus, consent: consentFor(bogus) })];
    expect(actual).toEqual([refuse('version_conflict'), refuse('version_conflict')]);
  });

  it('given a stored scope that does not match the stored policyDigest (plane corruption), should fail closed with store_unavailable', () => {
    const corrupt: PlaneBindingsRecord = { ...STORED, scope: WIDER.scope };
    const actual = decide({ stored: corrupt, next: SAME_SCOPE_BUMP, consent: null });
    expect(actual).toEqual(refuse('store_unavailable'));
  });
});
