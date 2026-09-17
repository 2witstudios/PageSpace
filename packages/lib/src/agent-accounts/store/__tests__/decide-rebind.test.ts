/**
 * ADR 0005 §2.2 `rebind`, §10.21 (G1a review H2) — RED before `decide-rebind.ts` existed.
 * One row per refusal, each changing exactly one fact from an otherwise valid rebind.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { AccountOwnerRef, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { Ed25519Verify, HashBytes, UserId } from '../../grant';
import type { OwnerConsent, PlaneBindings, PolicyDigest } from '../store-adapter';
import { canonicalJson } from '../../canonical-json';
import { digestBindings } from '../digest-bindings';
import { decideRebind } from '../decide-rebind';

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 300_000;
const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');

const consentKey = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');
const CONSENT_PUBLIC_KEY = new Uint8Array(consentKey.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

const STORED: PlaneBindings = {
  tenantId: 'user:owner' as TenantId,
  ownerRef: { kind: 'user', userId: 'owner' },
  allowedOrigins: ['https://api.example' as CanonicalOrigin],
  policyVersion: 3 as PolicyVersion,
  policyDigest: 'policy-digest-v3' as PolicyDigest,
  kind: 'api_key',
};
const NEXT: PlaneBindings = {
  ...STORED,
  allowedOrigins: ['https://api.example' as CanonicalOrigin, 'https://uploads.example' as CanonicalOrigin],
  policyVersion: 4 as PolicyVersion,
  policyDigest: 'policy-digest-v4' as PolicyDigest,
};

type UnsignedConsent = Omit<OwnerConsent, 'signature'>;

function signConsent(fields: UnsignedConsent, privateKey = consentKey.privateKey): OwnerConsent {
  const message = new TextEncoder().encode(canonicalJson(fields));
  return { ...fields, signature: nodeSign(null, message, privateKey).toString('base64') };
}

function consentFor(overrides: Partial<UnsignedConsent> = {}, privateKey = consentKey.privateKey): OwnerConsent {
  return signConsent(
    {
      consentId: 'consent_1',
      consentingUserId: 'owner' as UserId,
      stepUpChallengeId: 'challenge_1',
      bindingsDigest: digestBindings({ bindings: NEXT, hash: sha3 }),
      issuedAt: NOW - 1_000,
      ...overrides,
    },
    privateKey,
  );
}

function decide(overrides: Partial<Parameters<typeof decideRebind>[0]> = {}) {
  return decideRebind({
    stored: STORED,
    expectedVersion: 3 as PolicyVersion,
    next: NEXT,
    consent: consentFor(),
    consentPublicKey: CONSENT_PUBLIC_KEY,
    now: NOW,
    maxAgeMs: MAX_AGE_MS,
    verify,
    hash: sha3,
    ...overrides,
  });
}

describe('decideRebind', () => {
  it('given a fresh consent from the stored owner, signed under the pinned consent key over exactly the next bindings, with stored policyVersion === expectedVersion < next.policyVersion, should return rebind', () => {
    const actual = decide();
    const expected = { outcome: 'rebind' };
    expect(actual).toEqual(expected);
  });

  it('given stored null, should return not_found', () => {
    const actual = decide({ stored: null });
    const expected = { outcome: 'refuse', reason: 'not_found' };
    expect(actual).toEqual(expected);
  });

  it('given a consent whose bindingsDigest covers any other bindings than next, should return consent_invalid', () => {
    const otherBindings: PlaneBindings = { ...NEXT, allowedOrigins: [...NEXT.allowedOrigins, 'https://attacker.example' as CanonicalOrigin] };
    const actual = [
      decide({ consent: consentFor({ bindingsDigest: digestBindings({ bindings: otherBindings, hash: sha3 }) }) }),
      decide({ next: otherBindings }),
    ];
    const expected = [
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'refuse', reason: 'consent_invalid' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a consent signed by any key but the pinned consent key, a signature that is not base64, or a signed field altered after signing, should return consent_invalid', () => {
    const tampered: OwnerConsent = { ...consentFor(), stepUpChallengeId: 'challenge_other' };
    const actual = [
      decide({ consent: consentFor({}, otherKey.privateKey) }),
      decide({ consent: { ...consentFor(), signature: 'not base64!' } }),
      decide({ consent: tampered }),
    ];
    const expected = [
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'refuse', reason: 'consent_invalid' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a consent issued more than rebindConsentMaxAgeMs ago, or issued in the future, should return consent_invalid; exactly maxAgeMs old should still rebind', () => {
    const actual = [
      decide({ consent: consentFor({ issuedAt: NOW - MAX_AGE_MS - 1 }) }),
      decide({ consent: consentFor({ issuedAt: NOW + 1 }) }),
      decide({ consent: consentFor({ issuedAt: NOW - MAX_AGE_MS }) }),
    ];
    const expected = [
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'rebind' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a user-owned account and a consent from anyone but the STORED owner — including the owner a DB writer just wrote into next — should return consent_invalid', () => {
    const hijackedNext: PlaneBindings = { ...NEXT, ownerRef: { kind: 'user', userId: 'attacker' } };
    const actual = [
      decide({ consent: consentFor({ consentingUserId: 'attacker' as UserId }) }),
      decide({ next: hijackedNext, consent: consentFor({ consentingUserId: 'attacker' as UserId, bindingsDigest: digestBindings({ bindings: hijackedNext, hash: sha3 }) }) }),
    ];
    const expected = [
      { outcome: 'refuse', reason: 'consent_invalid' },
      { outcome: 'refuse', reason: 'consent_invalid' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given stored policyVersion !== expectedVersion, or next.policyVersion not strictly greater than expectedVersion, should return version_conflict', () => {
    const sameVersionNext: PlaneBindings = { ...NEXT, policyVersion: 3 as PolicyVersion };
    const actual = [
      decide({ expectedVersion: 2 as PolicyVersion }),
      decide({ next: sameVersionNext, consent: consentFor({ bindingsDigest: digestBindings({ bindings: sameVersionNext, hash: sha3 }) }) }),
    ];
    const expected = [
      { outcome: 'refuse', reason: 'version_conflict' },
      { outcome: 'refuse', reason: 'version_conflict' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given next bindings changing tenantId or kind, even with a valid consent to them, should return immutable_binding_changed', () => {
    const otherTenant: PlaneBindings = { ...NEXT, tenantId: 'user:elsewhere' as TenantId };
    const otherKind: PlaneBindings = { ...NEXT, kind: 'oauth2' };
    const actual = [otherTenant, otherKind].map((next) => decide({ next, consent: consentFor({ bindingsDigest: digestBindings({ bindings: next, hash: sha3 }) }) }));
    const expected = [
      { outcome: 'refuse', reason: 'immutable_binding_changed' },
      { outcome: 'refuse', reason: 'immutable_binding_changed' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given an agent-page-owned account, should accept a valid consent without a user-owner comparison (the stored owner is a page, not a user)', () => {
    const pageOwned: AccountOwnerRef = { kind: 'agent_page', agentPageId: 'page_1', driveId: 'drive_1' };
    const stored: PlaneBindings = { ...STORED, tenantId: 'drive:drive_1' as TenantId, ownerRef: pageOwned };
    const next: PlaneBindings = { ...NEXT, tenantId: 'drive:drive_1' as TenantId, ownerRef: pageOwned };
    const actual = decide({ stored, next, consent: consentFor({ consentingUserId: 'drive_admin' as UserId, bindingsDigest: digestBindings({ bindings: next, hash: sha3 }) }) });
    const expected = { outcome: 'rebind' };
    expect(actual).toEqual(expected);
  });
});
