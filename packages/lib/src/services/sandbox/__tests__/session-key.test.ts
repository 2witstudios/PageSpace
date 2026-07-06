import { describe, it, expect } from 'vitest';
import { deriveSessionKey } from '../session-key';

const base = {
  tenantId: 'tenant-1',
  driveId: 'drive-1',
  secret: 'a'.repeat(32),
};

describe('deriveSessionKey', () => {
  it('given identical inputs, should derive the same key (deterministic)', () => {
    expect(deriveSessionKey(base)).toBe(deriveSessionKey(base));
  });

  it('given a different drive (same tenant), should derive a different key (drive namespacing)', () => {
    expect(deriveSessionKey({ ...base, driveId: 'drive-2' })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given a different tenant (same drive), should derive a different key (tenant namespacing)', () => {
    expect(deriveSessionKey({ ...base, tenantId: 'tenant-2' })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given a different secret, should derive a different key (keyed/unguessable)', () => {
    expect(deriveSessionKey({ ...base, secret: 'b'.repeat(32) })).not.toBe(
      deriveSessionKey(base),
    );
  });

  it('given any inputs, should not embed the raw drive or tenant id (opaque)', () => {
    const key = deriveSessionKey(base);
    expect(key).not.toContain(base.driveId);
    expect(key).not.toContain(base.tenantId);
  });

  it('given any inputs, should produce a namespaced, sandbox-name-safe key', () => {
    const key = deriveSessionKey(base);
    expect(key.startsWith('pgs-sbx-')).toBe(true);
    // Only lowercase hex + the literal prefix — safe as a Sprite name.
    expect(key).toMatch(/^pgs-sbx-[0-9a-f]{64}$/);
  });

  it('given the same drive, should derive the same key regardless of caller (agent chat vs terminal)', () => {
    // The whole point of the per-drive namespace: two independent call sites
    // addressing the same (tenantId, driveId) land on the same Sprite.
    const fromAgentChat = deriveSessionKey({ tenantId: base.tenantId, driveId: base.driveId, secret: base.secret });
    const fromTerminal = deriveSessionKey({ tenantId: base.tenantId, driveId: base.driveId, secret: base.secret });
    expect(fromAgentChat).toBe(fromTerminal);
  });

  it('given an empty secret, should throw (fail closed — never derive a guessable key)', () => {
    expect(() => deriveSessionKey({ ...base, secret: '' })).toThrow(/non-empty secret/);
  });

  it('given a missing driveId, should throw (fail closed — no drive means no sandbox identity)', () => {
    const { driveId: _driveId, ...withoutDrive } = base;
    expect(() => deriveSessionKey(withoutDrive as typeof base)).toThrow(/non-empty driveId/);
  });

  it('given an empty-string driveId, should throw (fail closed)', () => {
    expect(() => deriveSessionKey({ ...base, driveId: '' })).toThrow(/non-empty driveId/);
  });

  it('given a missing tenantId, should throw (fail closed)', () => {
    const { tenantId: _tenantId, ...withoutTenant } = base;
    expect(() => deriveSessionKey(withoutTenant as typeof base)).toThrow(/non-empty tenantId/);
  });
});
