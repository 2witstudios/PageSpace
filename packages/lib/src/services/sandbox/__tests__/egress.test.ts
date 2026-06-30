import { describe, it, expect } from 'vitest';
import {
  buildSpriteNetworkPolicy,
  sanitizeEgressAllowlist,
  buildInternalSurfaceDenyRules,
} from '../egress';

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

describe('buildSpriteNetworkPolicy — open mode', () => {
  it('given egressMode: open, should deny the explicit internal surface, then defaults, then allow-all (no terminating deny)', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    expect(rules).toEqual([
      ...buildInternalSurfaceDenyRules(),
      { include: 'defaults' },
      { domain: '*', action: 'allow' },
    ]);
  });

  it('given egressMode: open, the explicit internal denies must come BEFORE the allow-all (first-match-wins)', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    const allowAllIdx = rules.findIndex((r) => r.domain === '*' && r.action === 'allow');
    const lastInternalDenyIdx = rules.reduce(
      (acc, r, i) => (r.action === 'deny' && r.domain !== '*' ? i : acc),
      -1,
    );
    expect(lastInternalDenyIdx).toBeGreaterThanOrEqual(0);
    expect(lastInternalDenyIdx).toBeLessThan(allowAllIdx);
  });

  it('given egressMode: open, should NOT lean solely on the include:defaults preset — explicit _api.internal deny present', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    expect(rules.some((r) => r.domain === '_api.internal' && r.action === 'deny')).toBe(true);
  });

  it('given egressMode: open, should include an allow-all domain rule', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    expect(rules.some((r) => r.domain === '*' && r.action === 'allow')).toBe(true);
  });

  it('given egressMode: open, must NOT contain a terminating deny-all rule', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    expect(rules.some((r) => r.domain === '*' && r.action === 'deny')).toBe(false);
  });

  it('given egressMode: open with an egressAllowlist, should ignore the allowlist (allowlist is irrelevant in open mode)', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressMode: 'open',
      egressAllowlist: ['registry.npmjs.org'],
    });
    expect(rules).toEqual([
      ...buildInternalSurfaceDenyRules(),
      { include: 'defaults' },
      { domain: '*', action: 'allow' },
    ]);
  });

  it('given egressMode: allowlist (explicit), should behave identically to the default (no-mode) path', () => {
    const withMode = buildSpriteNetworkPolicy({ egressMode: 'allowlist', egressAllowlist: ['pypi.org'] });
    const withoutMode = buildSpriteNetworkPolicy({ egressAllowlist: ['pypi.org'] });
    expect(withMode).toEqual(withoutMode);
  });

  it('given egressMode: allowlist and empty allowlist, should be pure deny-all (no change from default)', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'allowlist', egressAllowlist: [] });
    expect(rules).toEqual([{ domain: '*', action: 'deny' }]);
  });
});

describe('buildInternalSurfaceDenyRules', () => {
  it('given no input, should emit explicit deny rules for the Fly internal surface', () => {
    const rules = buildInternalSurfaceDenyRules();
    const denied = rules.map((r) => r.domain);
    expect(denied).toContain('_api.internal');
    expect(denied).toContain('*.internal');
    expect(denied).toContain('*.flycast');
    // Tigris / object-storage surface.
    expect(denied.some((d) => d?.includes('tigris'))).toBe(true);
  });

  it('every rule should be a deny (this builder never allows)', () => {
    expect(buildInternalSurfaceDenyRules().every((r) => r.action === 'deny')).toBe(true);
  });

  it('does NOT depend on the SDK include:defaults preset (explicit denies, belt-and-suspenders)', () => {
    expect(buildInternalSurfaceDenyRules().some((r) => 'include' in r)).toBe(false);
  });

  it('returns a fresh, clone-safe array each call (no shared mutation)', () => {
    const a = buildInternalSurfaceDenyRules();
    const b = buildInternalSurfaceDenyRules();
    expect(a).not.toBe(b);
    a.push({ domain: 'evil.test', action: 'allow' });
    expect(buildInternalSurfaceDenyRules().some((r) => r.domain === 'evil.test')).toBe(false);
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
