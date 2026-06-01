import { describe, it, expect } from 'vitest';
import { buildSandboxNetworkPolicy } from '../egress';

describe('buildSandboxNetworkPolicy', () => {
  it('given an empty allowlist, should be deny-all (default-deny egress)', () => {
    expect(buildSandboxNetworkPolicy({ egressAllowlist: [] })).toBe('deny-all');
  });

  it('given no input, should default to deny-all', () => {
    expect(buildSandboxNetworkPolicy()).toBe('deny-all');
  });

  it('given registry hosts, should allow only those hosts', () => {
    const policy = buildSandboxNetworkPolicy({
      egressAllowlist: ['registry.npmjs.org', 'pypi.org'],
    });
    expect(policy).not.toBe('deny-all');
    if (typeof policy === 'string') throw new Error('expected object policy');
    expect(policy.allow).toEqual({ 'registry.npmjs.org': [], 'pypi.org': [] });
  });

  it('given a widened allowlist, should deny the metadata endpoint and private ranges via subnets', () => {
    const policy = buildSandboxNetworkPolicy({ egressAllowlist: ['registry.npmjs.org'] });
    if (typeof policy === 'string') throw new Error('expected object policy');
    const denied = policy.subnets?.deny ?? [];
    expect(denied).toContain('169.254.0.0/16');
    expect(denied).toContain('10.0.0.0/8');
    expect(denied).toContain('172.16.0.0/12');
    expect(denied).toContain('192.168.0.0/16');
  });

  it('given duplicate/empty hosts, should dedupe and drop blanks', () => {
    const policy = buildSandboxNetworkPolicy({
      egressAllowlist: ['pypi.org', 'pypi.org', ''],
    });
    if (typeof policy === 'string') throw new Error('expected object policy');
    expect(Object.keys(policy.allow ?? {})).toEqual(['pypi.org']);
  });
});
