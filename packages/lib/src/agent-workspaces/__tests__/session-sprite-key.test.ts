import { describe, it, expect } from 'vitest';
import { deriveAgentSessionSpriteKey } from '../session-sprite-key';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const base = { tenantId: 'tenant-1', workspaceId: 'conv-1', secret: SECRET };

describe('deriveAgentSessionSpriteKey', () => {
  it('given the same inputs, should derive an identical key (a re-provision lands on the same Sprite name)', () => {
    expect(deriveAgentSessionSpriteKey(base)).toBe(deriveAgentSessionSpriteKey(base));
  });

  it('should carry the pgs-ses- prefix over a sha3-256 digest', () => {
    expect(deriveAgentSessionSpriteKey(base)).toMatch(/^pgs-ses-[0-9a-f]{64}$/);
  });

  it('should derive under the v2 namespace — v1 folded conversation ids in the SAME keyspace', () => {
    // v1 folded conversation cuids; v2 folds session cuids. Both are cuid2s, so
    // same-namespace reuse could let a v2 session derive the name of a v1
    // Sprite still awaiting reclaim. Pinned via a known-answer digest: any
    // change to the namespace, delimiter, or algorithm moves this value — and
    // reverting to v1 would too.
    const key = deriveAgentSessionSpriteKey({
      tenantId: 'tenant-fixed',
      workspaceId: 'session-fixed',
      secret: 's'.repeat(32),
    });
    // Known answer computed independently (node, sha3-256 HMAC over
    // 'agent-session-sprite:v2\0tenant-fixed\0session-fixed'), NOT derived from
    // the function under test — a snapshot of the function's own output would
    // pass under any namespace.
    expect(key).toBe('pgs-ses-63d5a311c2fdcf458fdb147886cbf23abfb39f940f195cc4de927e99e1c6b9a9');
  });

  it('given different session ids, should never collide (one session → one sandbox)', () => {
    const a = deriveAgentSessionSpriteKey({ ...base, workspaceId: 'conv-1' });
    const b = deriveAgentSessionSpriteKey({ ...base, workspaceId: 'conv-2' });
    expect(a).not.toBe(b);
  });

  it('given different tenants, should never collide', () => {
    const a = deriveAgentSessionSpriteKey({ ...base, tenantId: 'tenant-1' });
    const b = deriveAgentSessionSpriteKey({ ...base, tenantId: 'tenant-2' });
    expect(a).not.toBe(b);
  });

  it('given a different secret, should derive a different key', () => {
    const rotated = deriveAgentSessionSpriteKey({ ...base, secret: `${SECRET}-rotated` });
    expect(rotated).not.toBe(deriveAgentSessionSpriteKey(base));
  });

  it('should not let a (tenant, session) pair be re-spelled into another pair (delimited fold)', () => {
    const a = deriveAgentSessionSpriteKey({ ...base, tenantId: 'a', workspaceId: 'bc' });
    const b = deriveAgentSessionSpriteKey({ ...base, tenantId: 'ab', workspaceId: 'c' });
    expect(a).not.toBe(b);
  });

  it('given a NUL inside tenantId, should throw — a smuggled delimiter re-spells the pair', () => {
    // Without the guard, {tenant:'a\0b', session:'c'} and {tenant:'a',
    // session:'b\0c'} fold to the SAME payload and therefore the same Sprite
    // name. Both ids are server-minted cuids today, but this function is the
    // security boundary, so injectivity is enforced here, not assumed.
    expect(() => deriveAgentSessionSpriteKey({ ...base, tenantId: 'a\0b', workspaceId: 'c' })).toThrow(/tenantId/);
  });

  it('given a NUL inside workspaceId, should throw — the other half of the same collision', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, tenantId: 'a', workspaceId: 'b\0c' })).toThrow(/workspaceId/);
  });

  it('given an empty secret, should throw (fail closed — never derive an unkeyed name)', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, secret: '' })).toThrow(/secret/);
  });

  it('given a secret shorter than 32 chars, should throw (weak key material is treated as unset)', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, secret: 'a'.repeat(31) })).toThrow(/secret/);
  });

  it('given a 32-char secret, should derive (the boundary is inclusive)', () => {
    expect(deriveAgentSessionSpriteKey({ ...base, secret: 'a'.repeat(32) })).toMatch(/^pgs-ses-/);
  });

  it('given an empty tenantId, should throw (fail closed — an un-namespaced key is cross-tenant)', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, tenantId: '' })).toThrow(/tenantId/);
  });

  it('given an empty workspaceId, should throw (fail closed)', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, workspaceId: '' })).toThrow(/workspaceId/);
  });
});
