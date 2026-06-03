import { describe, it, expect } from 'vitest';
import { buildSpriteNetworkPolicy, sanitizeEgressAllowlist } from '../egress';

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

  it('given a wildcard "*" entry, should drop it so it cannot short-circuit the terminating deny', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['*', 'registry.npmjs.org'] });
    expect(rules.some((r) => r.action === 'allow' && r.domain === '*')).toBe(false);
    expect(rules).toContainEqual({ domain: 'registry.npmjs.org', action: 'allow' });
    expect(rules[rules.length - 1]).toEqual({ domain: '*', action: 'deny' });
  });

  it('given an allowlist of only invalid entries, should collapse to pure deny-all', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: ['*', '10.0.0.1', '::1', 'https://evil.com', 'host:443', 'a/b'],
    });
    expect(rules).toEqual([{ domain: '*', action: 'deny' }]);
  });
});

describe('sanitizeEgressAllowlist', () => {
  it('keeps literal hostnames, trimmed and lowercased', () => {
    expect(sanitizeEgressAllowlist([' Registry.NPMJS.org ', 'pypi.org'])).toEqual([
      'registry.npmjs.org',
      'pypi.org',
    ]);
  });

  it('drops wildcards, IP literals, and non-host strings', () => {
    expect(
      sanitizeEgressAllowlist([
        '*',
        '1.2.3.4',
        '2001:db8::1',
        'https://example.com',
        'example.com/path',
        'example.com:8080',
        '',
        '   ',
      ]),
    ).toEqual([]);
  });

  it('dedupes after canonicalization', () => {
    expect(sanitizeEgressAllowlist(['Example.com', 'example.com'])).toEqual(['example.com']);
  });
});
