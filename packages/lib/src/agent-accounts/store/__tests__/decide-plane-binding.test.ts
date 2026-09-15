/**
 * ADR 0005 §2.4, F4 — RED at G1b-store before `decide-plane-binding.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { TenantId, AccountOwnerRef, PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { BindingDigest } from '../../grant';
import type { PlaneBindings } from '../store-adapter';
import { digestBindings } from '../digest-bindings';
import { decidePlaneBinding } from '../decide-plane-binding';

const fakeHash = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const bindings: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  kind: 'api_key',
};

describe('decidePlaneBinding', () => {
  it('given a grant digest that matches the stored bindings, should return ok', () => {
    const grantBindingDigest = digestBindings({ bindings, hash: fakeHash });
    const actual = decidePlaneBinding({ storedBindings: bindings, grantBindingDigest, hash: fakeHash });
    expect(actual).toEqual({ ok: true });
  });

  it('given stored bindings with a changed ownerRef, should return binding_mismatch', () => {
    const grantBindingDigest = digestBindings({ bindings, hash: fakeHash });
    const tampered: PlaneBindings = { ...bindings, ownerRef: { kind: 'user', userId: 'attacker' } };
    const actual = decidePlaneBinding({ storedBindings: tampered, grantBindingDigest, hash: fakeHash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given stored bindings whose policyVersion differs from what the digest was computed over, should return binding_mismatch', () => {
    const grantBindingDigest = digestBindings({ bindings, hash: fakeHash });
    const tampered: PlaneBindings = { ...bindings, policyVersion: 2 as PolicyVersion };
    const actual = decidePlaneBinding({ storedBindings: tampered, grantBindingDigest, hash: fakeHash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('given a digest computed over unrelated bindings, should return binding_mismatch', () => {
    const actual = decidePlaneBinding({ storedBindings: bindings, grantBindingDigest: 'not-a-real-digest' as BindingDigest, hash: fakeHash });
    expect(actual).toEqual({ ok: false, reason: 'binding_mismatch' });
  });
});
