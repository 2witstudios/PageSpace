import { describe, it, expect } from 'vitest';
import { deriveDriveEnvSpriteKey } from '../env-sprite-key';
import { deriveAgentSessionSpriteKey } from '../../agent-workspaces/workspace-sprite-key';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const BASE = { tenantId: 'tenant-1', envId: 'env-1', secret: SECRET };

describe('deriveDriveEnvSpriteKey', () => {
  it('given the same inputs, should derive an identical key (a re-provision lands on the same Sprite name)', () => {
    expect(deriveDriveEnvSpriteKey(BASE)).toBe(deriveDriveEnvSpriteKey(BASE));
  });

  it('should carry the pgs-env- prefix over a sha3-256 digest', () => {
    expect(deriveDriveEnvSpriteKey(BASE)).toMatch(/^pgs-env-[0-9a-f]{64}$/);
  });

  it('should derive under the drive-env-sprite:v1 namespace', () => {
    // Pinned via a known-answer digest: any change to the namespace, delimiter,
    // or algorithm moves this value. Computed independently (node, sha3-256 HMAC
    // over 'drive-env-sprite:v1\0tenant-fixed\0env-fixed'), NOT snapshotted from
    // the function under test — a snapshot of its own output would pass under
    // any namespace.
    const key = deriveDriveEnvSpriteKey({ tenantId: 'tenant-fixed', envId: 'env-fixed', secret: 's'.repeat(32) });
    expect(key).toBe('pgs-env-e61ee466be358ebca8a6cadf911e85e0a8984f6783e74f13b946493e4fdb84b5');
  });

  it('given the SAME tenant and id as a session, should derive a different key — environments get a fresh keyspace', () => {
    // The whole reason the namespace is fresh rather than shared: environment ids
    // and session ids are both server-minted cuid2s drawn from one alphabet, so a
    // shared namespace would let an environment derive the name of a session
    // Sprite still awaiting reclaim and provision onto a VM the outbox is about
    // to kill. The digests differ, not merely the prefixes — the namespace string
    // is inside the HMAC payload, so stripping the prefix cannot make them
    // collide.
    const envKey = deriveDriveEnvSpriteKey({ tenantId: 'tenant-fixed', envId: 'shared-id', secret: 's'.repeat(32) });
    const sessionKey = deriveAgentSessionSpriteKey({
      tenantId: 'tenant-fixed',
      workspaceId: 'shared-id',
      secret: 's'.repeat(32),
    });
    expect(envKey).not.toBe(sessionKey);
    expect(envKey.replace(/^pgs-env-/, '')).not.toBe(sessionKey.replace(/^pgs-ses-/, ''));
  });

  it('given different env ids, should never collide (one environment → one sandbox)', () => {
    expect(deriveDriveEnvSpriteKey({ ...BASE, envId: 'env-1' })).not.toBe(
      deriveDriveEnvSpriteKey({ ...BASE, envId: 'env-2' }),
    );
  });

  it('given different tenants, should never collide', () => {
    expect(deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'tenant-1' })).not.toBe(
      deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'tenant-2' }),
    );
  });

  it('given a different secret, should derive a different key', () => {
    expect(deriveDriveEnvSpriteKey({ ...BASE, secret: `${SECRET}-rotated` })).not.toBe(deriveDriveEnvSpriteKey(BASE));
  });

  it('should not let a (tenant, env) pair be re-spelled into another pair (delimited fold)', () => {
    const a = deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'a', envId: 'bc' });
    const b = deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'ab', envId: 'c' });
    expect(a).not.toBe(b);
  });

  it('given a NUL inside tenantId, should throw — a smuggled delimiter re-spells the pair', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'a\0b', envId: 'c' })).toThrow(/tenantId/);
  });

  it('given a NUL inside envId, should throw — the other half of the same collision', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, tenantId: 'a', envId: 'b\0c' })).toThrow(/envId/);
  });

  it('given an empty secret, should throw (fail closed — never derive an unkeyed name)', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, secret: '' })).toThrow(/secret/);
  });

  it('given a secret shorter than 32 chars, should throw (weak key material is treated as unset)', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, secret: 'a'.repeat(31) })).toThrow(/secret/);
  });

  it('given a 32-char secret, should derive (the boundary is inclusive)', () => {
    expect(deriveDriveEnvSpriteKey({ ...BASE, secret: 'a'.repeat(32) })).toMatch(/^pgs-env-/);
  });

  it('given an empty tenantId, should throw (fail closed — an un-namespaced key is cross-tenant)', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, tenantId: '' })).toThrow(/tenantId/);
  });

  it('given an empty envId, should throw (fail closed)', () => {
    expect(() => deriveDriveEnvSpriteKey({ ...BASE, envId: '' })).toThrow(/envId/);
  });
});
