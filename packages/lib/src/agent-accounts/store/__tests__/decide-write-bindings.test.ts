/**
 * ADR 0005 §2.2 (G1a review H2) — RED before `decide-write-bindings.ts` existed. `rebind` is the
 * ONE path that rewrites a ref's `PlaneBindings`; a `put` or `rotate` onto an existing ref must
 * carry exactly the stored bindings, or it could revert a consented rebind or widen scope with no
 * consent at all.
 */
import { describe, it, expect } from 'vitest';
import type { PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { PlaneBindings, PolicyDigest } from '../store-adapter';
import { decideWriteBindings } from '../decide-write-bindings';

const STORED: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' },
  allowedOrigins: ['https://api.example' as CanonicalOrigin],
  policyVersion: 2 as PolicyVersion,
  policyDigest: 'policy-digest-v2' as PolicyDigest,
  kind: 'api_key',
};

describe('decideWriteBindings', () => {
  it('given no stored bindings (the first put), should accept whatever bindings the put carries', () => {
    const actual = decideWriteBindings({ stored: null, written: STORED });
    const expected = { ok: true };
    expect(actual).toEqual(expected);
  });

  it('given written bindings equal to the stored ones, in any key order, should accept', () => {
    const reordered: PlaneBindings = { kind: 'api_key', policyDigest: STORED.policyDigest, policyVersion: STORED.policyVersion, allowedOrigins: STORED.allowedOrigins, ownerRef: STORED.ownerRef, tenantId: STORED.tenantId };
    const actual = decideWriteBindings({ stored: STORED, written: reordered });
    const expected = { ok: true };
    expect(actual).toEqual(expected);
  });

  it('given written bindings that revert a rebind, widen origins, swap the owner or change only the policyDigest, should refuse each as version_conflict', () => {
    const variants: readonly PlaneBindings[] = [
      { ...STORED, policyVersion: 1 as PolicyVersion, policyDigest: 'policy-digest-v1' as PolicyDigest },
      { ...STORED, allowedOrigins: [...STORED.allowedOrigins, 'https://attacker.example' as CanonicalOrigin] },
      { ...STORED, ownerRef: { kind: 'user', userId: 'attacker' } },
      { ...STORED, policyDigest: 'policy-digest-widened' as PolicyDigest },
    ];
    const actual = variants.map((written) => decideWriteBindings({ stored: STORED, written }));
    const expected = variants.map(() => ({ ok: false, reason: 'version_conflict' }));
    expect(actual).toEqual(expected);
  });
});
