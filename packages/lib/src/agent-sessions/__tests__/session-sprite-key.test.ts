import { describe, it, expect } from 'vitest';
import { deriveAgentSessionSpriteKey } from '../session-sprite-key';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const base = { tenantId: 'tenant-1', sessionId: 'conv-1', secret: SECRET };

describe('deriveAgentSessionSpriteKey', () => {
  it('given the same inputs, should derive an identical key (a re-provision lands on the same Sprite name)', () => {
    expect(deriveAgentSessionSpriteKey(base)).toBe(deriveAgentSessionSpriteKey(base));
  });

  it('should carry the pgs-ses- prefix over a sha3-256 digest', () => {
    expect(deriveAgentSessionSpriteKey(base)).toMatch(/^pgs-ses-[0-9a-f]{64}$/);
  });

  it('given different session ids, should never collide (one session → one sandbox)', () => {
    const a = deriveAgentSessionSpriteKey({ ...base, sessionId: 'conv-1' });
    const b = deriveAgentSessionSpriteKey({ ...base, sessionId: 'conv-2' });
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
    const a = deriveAgentSessionSpriteKey({ ...base, tenantId: 'a', sessionId: 'bc' });
    const b = deriveAgentSessionSpriteKey({ ...base, tenantId: 'ab', sessionId: 'c' });
    expect(a).not.toBe(b);
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

  it('given an empty sessionId, should throw (fail closed)', () => {
    expect(() => deriveAgentSessionSpriteKey({ ...base, sessionId: '' })).toThrow(/sessionId/);
  });
});
