import { describe, it, expect } from 'vitest';
import { intersectCapabilities, capabilityForOp } from '../intersect-capabilities';
import type { AdvertisedCapabilities, AllowedOperations } from '../policy-types';

const ALL_ADVERTISED: AdvertisedCapabilities = { shell: true, pty: true, fs: true, checkpoint: false };
const ALL_OPS: AllowedOperations = { ops: ['exec', 'fs_read', 'fs_write', 'pty_open'], checkpoint: false };

describe('intersectCapabilities — effective permission is the intersection of what the machine can do, what the server allows, and what the machine allows (invariant 4)', () => {
  it('given all three allow everything, should allow every op', () => {
    expect(intersectCapabilities(ALL_ADVERTISED, ALL_OPS, ALL_OPS)).toEqual({ exec: true, fs_read: true, fs_write: true, pty_open: true, checkpoint: false });
  });

  it('given an op missing on the SERVER side, should make it absent', () => {
    const server: AllowedOperations = { ops: ['exec'], checkpoint: false };
    expect(intersectCapabilities(ALL_ADVERTISED, server, ALL_OPS)).toEqual({ exec: true, fs_read: false, fs_write: false, pty_open: false, checkpoint: false });
  });

  it('given an op missing on the MACHINE side, should make it absent', () => {
    const machine: AllowedOperations = { ops: ['fs_read'], checkpoint: false };
    expect(intersectCapabilities(ALL_ADVERTISED, ALL_OPS, machine)).toEqual({ exec: false, fs_read: true, fs_write: false, pty_open: false, checkpoint: false });
  });

  it('given pty not advertised (node-pty absent), should make pty_open absent even if both policies allow it', () => {
    expect(intersectCapabilities({ ...ALL_ADVERTISED, pty: false }, ALL_OPS, ALL_OPS).pty_open).toBe(false);
  });

  it('given fs not advertised, should make both fs ops absent', () => {
    const eff = intersectCapabilities({ ...ALL_ADVERTISED, fs: false }, ALL_OPS, ALL_OPS);
    expect(eff.fs_read).toBe(false);
    expect(eff.fs_write).toBe(false);
  });

  it('given shell not advertised, should make exec absent', () => {
    expect(intersectCapabilities({ ...ALL_ADVERTISED, shell: false }, ALL_OPS, ALL_OPS).exec).toBe(false);
  });

  it('should never grant checkpoint unless ALL three say so (invariant 12 — no silent safety degradation)', () => {
    expect(intersectCapabilities({ ...ALL_ADVERTISED, checkpoint: true }, ALL_OPS, ALL_OPS).checkpoint).toBe(false);
    expect(intersectCapabilities({ ...ALL_ADVERTISED, checkpoint: true }, { ...ALL_OPS, checkpoint: true }, ALL_OPS).checkpoint).toBe(false);
    expect(intersectCapabilities({ ...ALL_ADVERTISED, checkpoint: true }, { ...ALL_OPS, checkpoint: true }, { ...ALL_OPS, checkpoint: true }).checkpoint).toBe(true);
  });

  it('capabilityForOp should map every op to exactly one advertised capability', () => {
    expect(capabilityForOp('exec')).toBe('shell');
    expect(capabilityForOp('fs_read')).toBe('fs');
    expect(capabilityForOp('fs_write')).toBe('fs');
    expect(capabilityForOp('pty_open')).toBe('pty');
  });

  it('should be pure: same inputs, same output; inputs not mutated', () => {
    const a = intersectCapabilities(ALL_ADVERTISED, ALL_OPS, ALL_OPS);
    const b = intersectCapabilities(ALL_ADVERTISED, ALL_OPS, ALL_OPS);
    expect(a).toEqual(b);
    expect(ALL_OPS.ops).toEqual(['exec', 'fs_read', 'fs_write', 'pty_open']);
  });
});
