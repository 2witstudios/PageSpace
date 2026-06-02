import { describe, it, expect } from 'vitest';
import { deriveSessionKey } from '../session-key';

const base = {
  tenantId: 'tenant-1',
  driveId: 'drive-1',
  conversationId: 'conv-1',
  secret: 'a'.repeat(32),
};

describe('deriveSessionKey', () => {
  it('given identical inputs, should derive the same key (deterministic)', () => {
    expect(deriveSessionKey(base)).toBe(deriveSessionKey(base));
  });

  it('given a different conversation, should derive a different key', () => {
    expect(deriveSessionKey({ ...base, conversationId: 'conv-2' })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given a different drive, should derive a different key (drive namespacing)', () => {
    expect(deriveSessionKey({ ...base, driveId: 'drive-2' })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given a different tenant, should derive a different key (tenant namespacing)', () => {
    expect(deriveSessionKey({ ...base, tenantId: 'tenant-2' })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given a different secret, should derive a different key (keyed/unguessable)', () => {
    expect(deriveSessionKey({ ...base, secret: 'b'.repeat(32) })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given any inputs, should not embed the raw conversation id (opaque)', () => {
    const key = deriveSessionKey(base);
    expect(key).not.toContain(base.conversationId);
    expect(key).not.toContain(base.driveId);
    expect(key).not.toContain(base.tenantId);
  });

  it('given any inputs, should produce a namespaced, sandbox-name-safe key', () => {
    const key = deriveSessionKey(base);
    expect(key.startsWith('pgs-sbx-')).toBe(true);
    // Only lowercase hex + the literal prefix — safe as a Sprite name.
    expect(key).toMatch(/^pgs-sbx-[0-9a-f]{64}$/);
  });

  it('given an empty secret, should throw (fail closed — never derive a guessable key)', () => {
    expect(() => deriveSessionKey({ ...base, secret: '' })).toThrow(/non-empty secret/);
  });
});
