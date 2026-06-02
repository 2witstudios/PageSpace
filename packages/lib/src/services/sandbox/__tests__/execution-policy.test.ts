import { describe, it, expect } from 'vitest';
import { resolveExecutionPolicy, SAFE_MINIMUM_PROFILE } from '../execution-policy';

describe('resolveExecutionPolicy', () => {
  it('given no profile, should resolve the default profile with explicit caps', () => {
    const policy = resolveExecutionPolicy();
    expect(policy.timeoutMs).toBeGreaterThan(0);
    expect(policy.vcpus).toBeGreaterThan(0);
    expect(policy.memoryMb).toBeGreaterThan(0);
    expect(policy.maxOutputBytes).toBeGreaterThan(0);
  });

  it('given any profile, should default-deny egress with an empty allowlist', () => {
    expect(resolveExecutionPolicy({ profile: 'default' }).egressAllowlist).toEqual([]);
    expect(resolveExecutionPolicy({ profile: 'minimal' }).egressAllowlist).toEqual([]);
  });

  it('given any profile, should never request a persistent sandbox', () => {
    expect(resolveExecutionPolicy({ profile: 'default' }).persistent).toBe(false);
    expect(resolveExecutionPolicy({ profile: 'minimal' }).persistent).toBe(false);
  });

  it('given an unknown profile, should fall back to the safe minimum', () => {
    const policy = resolveExecutionPolicy({ profile: 'totally-made-up' });
    expect(policy).toEqual(SAFE_MINIMUM_PROFILE);
  });

  it('given a prototype key as the profile, should fall back to the safe minimum (no inherited lookup)', () => {
    // A bracket lookup would resolve these to truthy Object.prototype members and
    // skip the fallback, yielding a policy with no bounds. The own-key guard must
    // treat them as unknown profiles.
    for (const profile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const policy = resolveExecutionPolicy({ profile });
      expect(policy).toEqual(SAFE_MINIMUM_PROFILE);
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(policy.egressAllowlist).toEqual([]);
    }
  });

  it('given the minimal profile, should be no more permissive than the default profile', () => {
    const minimal = resolveExecutionPolicy({ profile: 'minimal' });
    const def = resolveExecutionPolicy({ profile: 'default' });
    expect(minimal.timeoutMs).toBeLessThanOrEqual(def.timeoutMs);
    expect(minimal.memoryMb).toBeLessThanOrEqual(def.memoryMb);
    expect(minimal.maxOutputBytes).toBeLessThanOrEqual(def.maxOutputBytes);
  });

  it('should set an explicit region rather than relying on a platform default', () => {
    expect(resolveExecutionPolicy().region).toBe('iad');
  });

  it('should tag the resolved policy with the profile name it represents', () => {
    expect(resolveExecutionPolicy({ profile: 'default' }).profile).toBe('default');
    expect(resolveExecutionPolicy({ profile: 'minimal' }).profile).toBe('minimal');
  });

  it('should return an immutable policy so the default-deny egress baseline cannot be mutated', () => {
    const policy = resolveExecutionPolicy();
    expect(() => {
      (policy.egressAllowlist as string[]).push('evil.example.com');
    }).toThrow();
    expect(policy.egressAllowlist).toEqual([]);
  });
});
