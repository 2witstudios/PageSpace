import { describe, it, expect } from 'vitest';
import { buildSpriteNetworkPolicy, normalizeEgressHost } from '../egress';

describe('buildSpriteNetworkPolicy', () => {
  it('given an empty allowlist, should be pure deny-all (default-deny egress)', () => {
    expect(buildSpriteNetworkPolicy({ egressAllowlist: [] })).toEqual({
      rules: [{ domain: '*', action: 'deny' }],
    });
  });

  it('given no input, should default to deny-all', () => {
    expect(buildSpriteNetworkPolicy()).toEqual({ rules: [{ domain: '*', action: 'deny' }] });
  });

  it('given registry hosts, should allow them and terminate with a deny-all catch-all', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: ['registry.npmjs.org', 'pypi.org'],
    });
    expect(rules).toContainEqual({ domain: 'registry.npmjs.org', action: 'allow' });
    expect(rules).toContainEqual({ domain: 'pypi.org', action: 'allow' });
    // Catch-all deny must be the final rule.
    expect(rules[rules.length - 1]).toEqual({ domain: '*', action: 'deny' });
  });

  it('given a widened allowlist, should include the SDK internal-blocking defaults BEFORE any allow', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['registry.npmjs.org'] });
    const includeIdx = rules.findIndex((r) => r.include === 'defaults');
    const allowIdx = rules.findIndex((r) => r.domain === 'registry.npmjs.org');
    // The internal surface is denied via the maintained `defaults` preset, placed
    // first so a later `*` allow could never reach it.
    expect(includeIdx).toBe(0);
    expect(includeIdx).toBeLessThan(allowIdx);
    expect(rules[0]).toEqual({ include: 'defaults' });
    // Still terminates in default-deny.
    expect(rules[rules.length - 1]).toEqual({ domain: '*', action: 'deny' });
  });

  it('given an empty allowlist, should NOT include the defaults preset (pure deny-all, no preset semantics)', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: [] });
    expect(rules.some((r) => r.include === 'defaults')).toBe(false);
    expect(rules).toEqual([{ domain: '*', action: 'deny' }]);
  });

  it('given duplicate/empty hosts, should dedupe and drop blanks', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['pypi.org', 'pypi.org', ''] });
    const allows = rules.filter((r) => r.action === 'allow');
    expect(allows).toEqual([{ domain: 'pypi.org', action: 'allow' }]);
  });

  it('given a bare "*" allow entry, should DROP it so the deny-all catch-all is not shadowed', () => {
    // First-match-wins: a `*` allow before the terminating deny would open all
    // egress. It must never reach the rule list.
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['*'] });
    expect(rules).toEqual([{ domain: '*', action: 'deny' }]);
    expect(rules.some((r) => r.action === 'allow')).toBe(false);
  });

  it('given IP literals / URLs / ports / localhost, should drop them (domain rules only match names)', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: [
        '1.2.3.4',
        '169.254.169.254',
        'fdaa::1',
        'https://evil.com/path',
        'evil.com:8080',
        'localhost',
        'foo bar',
      ],
    });
    expect(rules.some((r) => r.action === 'allow')).toBe(false);
    expect(rules).toEqual([{ domain: '*', action: 'deny' }]);
  });

  it('given a leading-wildcard host, should normalize and allow it', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['*.GitHub.com'] });
    expect(rules).toContainEqual({ domain: '*.github.com', action: 'allow' });
    expect(rules[rules.length - 1]).toEqual({ domain: '*', action: 'deny' });
  });
});

describe('normalizeEgressHost', () => {
  it('should accept literal hostnames and a single leading wildcard, lowercasing/trimming', () => {
    expect(normalizeEgressHost('  Registry.NPMJS.org ')).toBe('registry.npmjs.org');
    expect(normalizeEgressHost('*.example.com')).toBe('*.example.com');
    expect(normalizeEgressHost('pypi.org')).toBe('pypi.org');
  });

  it('should reject wildcards-without-domain, IP literals, schemes, ports, and single labels', () => {
    for (const bad of [
      '',
      '*',
      '*.*',
      '1.2.3.4',
      '169.254.169.254',
      'fdaa::1',
      'http://x.com',
      'x.com/y',
      'x.com:443',
      'user@x.com',
      'localhost',
      'a b.com',
    ]) {
      expect(normalizeEgressHost(bad)).toBeNull();
    }
  });
});
