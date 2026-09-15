/**
 * ADR 0005 §2.4, §10.5 — RED at G1b-store before `digest-bindings.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { TenantId, AccountOwnerRef, PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { PlaneBindings } from '../store-adapter';
import { digestBindings } from '../digest-bindings';

const fakeHash = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const owner: AccountOwnerRef = { kind: 'user', userId: 'u1' };
const origin = (value: string): CanonicalOrigin => value as CanonicalOrigin;

const bindings = (overrides: Partial<PlaneBindings> = {}): PlaneBindings => ({
  tenantId: 'user:u1' as TenantId,
  ownerRef: owner,
  allowedOrigins: [origin('https://example.com')],
  policyVersion: 1 as PolicyVersion,
  kind: 'api_key',
  ...overrides,
});

describe('digestBindings', () => {
  it('given the same bindings twice, should return the same digest (pure)', () => {
    const input = bindings();
    const actual = [digestBindings({ bindings: input, hash: fakeHash }), digestBindings({ bindings: input, hash: fakeHash })];
    expect(actual[0]).toBe(actual[1]);
  });

  it('given bindings differing only in key order, should compare equal (canonical JSON)', () => {
    const a = digestBindings({ bindings: bindings(), hash: fakeHash });
    const reordered: PlaneBindings = {
      kind: 'api_key',
      policyVersion: 1 as PolicyVersion,
      allowedOrigins: [origin('https://example.com')],
      ownerRef: owner,
      tenantId: 'user:u1' as TenantId,
    };
    const b = digestBindings({ bindings: reordered, hash: fakeHash });
    expect(a).toBe(b);
  });

  it('given a changed allowedOrigins, should return a different digest', () => {
    const a = digestBindings({ bindings: bindings(), hash: fakeHash });
    const b = digestBindings({ bindings: bindings({ allowedOrigins: [origin('https://other.example')] }), hash: fakeHash });
    expect(a).not.toBe(b);
  });

  it('given a changed policyVersion, should return a different digest', () => {
    const a = digestBindings({ bindings: bindings(), hash: fakeHash });
    const b = digestBindings({ bindings: bindings({ policyVersion: 2 as PolicyVersion }), hash: fakeHash });
    expect(a).not.toBe(b);
  });
});
