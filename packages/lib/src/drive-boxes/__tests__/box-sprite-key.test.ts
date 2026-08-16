import { describe, it, expect } from 'vitest';
import { deriveDriveBoxSpriteKey } from '../box-sprite-key';
import { deriveAgentSessionSpriteKey } from '../../agent-workspaces/workspace-sprite-key';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const base = { tenantId: 'tenant-1', boxId: 'box-1', secret: SECRET };

describe('deriveDriveBoxSpriteKey', () => {
  it('given the same inputs, should derive an identical key (a re-provision lands on the same Sprite name)', () => {
    expect(deriveDriveBoxSpriteKey(base)).toBe(deriveDriveBoxSpriteKey(base));
  });

  it('should carry the pgs-box- prefix over a sha3-256 digest', () => {
    expect(deriveDriveBoxSpriteKey(base)).toMatch(/^pgs-box-[0-9a-f]{64}$/);
  });

  it('should derive under the drive-box-sprite:v1 namespace', () => {
    // Pinned via a known-answer digest: any change to the namespace, delimiter,
    // or algorithm moves this value. Computed independently (node, sha3-256 HMAC
    // over 'drive-box-sprite:v1\0tenant-fixed\0box-fixed'), NOT snapshotted from
    // the function under test — a snapshot of its own output would pass under
    // any namespace.
    const key = deriveDriveBoxSpriteKey({ tenantId: 'tenant-fixed', boxId: 'box-fixed', secret: 's'.repeat(32) });
    expect(key).toBe('pgs-box-c718a881853250ae283cc97c92c84438476d902208ace8d93d1b575fc0128240');
  });

  it('given the SAME tenant and id as a session, should derive a different key — boxes get a fresh keyspace', () => {
    // The whole reason the namespace is fresh rather than shared: box ids and
    // session ids are both server-minted cuid2s drawn from one alphabet, so a
    // shared namespace would let a box derive the name of a session Sprite still
    // awaiting reclaim and provision onto a VM the outbox is about to kill. The
    // digests differ, not merely the prefixes — the namespace string is inside
    // the HMAC payload, so stripping the prefix cannot make them collide.
    const boxKey = deriveDriveBoxSpriteKey({ tenantId: 'tenant-fixed', boxId: 'shared-id', secret: 's'.repeat(32) });
    const sessionKey = deriveAgentSessionSpriteKey({
      tenantId: 'tenant-fixed',
      workspaceId: 'shared-id',
      secret: 's'.repeat(32),
    });
    expect(boxKey).not.toBe(sessionKey);
    expect(boxKey.replace(/^pgs-box-/, '')).not.toBe(sessionKey.replace(/^pgs-ses-/, ''));
  });

  it('given different box ids, should never collide (one box → one sandbox)', () => {
    expect(deriveDriveBoxSpriteKey({ ...base, boxId: 'box-1' })).not.toBe(
      deriveDriveBoxSpriteKey({ ...base, boxId: 'box-2' }),
    );
  });

  it('given different tenants, should never collide', () => {
    expect(deriveDriveBoxSpriteKey({ ...base, tenantId: 'tenant-1' })).not.toBe(
      deriveDriveBoxSpriteKey({ ...base, tenantId: 'tenant-2' }),
    );
  });

  it('given a different secret, should derive a different key', () => {
    expect(deriveDriveBoxSpriteKey({ ...base, secret: `${SECRET}-rotated` })).not.toBe(deriveDriveBoxSpriteKey(base));
  });

  it('should not let a (tenant, box) pair be re-spelled into another pair (delimited fold)', () => {
    const a = deriveDriveBoxSpriteKey({ ...base, tenantId: 'a', boxId: 'bc' });
    const b = deriveDriveBoxSpriteKey({ ...base, tenantId: 'ab', boxId: 'c' });
    expect(a).not.toBe(b);
  });

  it('given a NUL inside tenantId, should throw — a smuggled delimiter re-spells the pair', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, tenantId: 'a\0b', boxId: 'c' })).toThrow(/tenantId/);
  });

  it('given a NUL inside boxId, should throw — the other half of the same collision', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, tenantId: 'a', boxId: 'b\0c' })).toThrow(/boxId/);
  });

  it('given an empty secret, should throw (fail closed — never derive an unkeyed name)', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, secret: '' })).toThrow(/secret/);
  });

  it('given a secret shorter than 32 chars, should throw (weak key material is treated as unset)', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, secret: 'a'.repeat(31) })).toThrow(/secret/);
  });

  it('given a 32-char secret, should derive (the boundary is inclusive)', () => {
    expect(deriveDriveBoxSpriteKey({ ...base, secret: 'a'.repeat(32) })).toMatch(/^pgs-box-/);
  });

  it('given an empty tenantId, should throw (fail closed — an un-namespaced key is cross-tenant)', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, tenantId: '' })).toThrow(/tenantId/);
  });

  it('given an empty boxId, should throw (fail closed)', () => {
    expect(() => deriveDriveBoxSpriteKey({ ...base, boxId: '' })).toThrow(/boxId/);
  });
});
