import { describe, it, expect } from 'vitest';
import { buildSpriteNetworkPolicy } from '../egress';

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

  it('given a widened allowlist, should deny the internal Fly surface BEFORE any allow', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['registry.npmjs.org'] });
    const denyInternalIdx = rules.findIndex(
      (r) => r.domain === '*.internal' && r.action === 'deny',
    );
    const allowIdx = rules.findIndex((r) => r.domain === 'registry.npmjs.org');
    expect(denyInternalIdx).toBeGreaterThanOrEqual(0);
    expect(denyInternalIdx).toBeLessThan(allowIdx);
    // Tigris + metadata + flycast are denied too.
    expect(rules).toContainEqual({ domain: '*.tigris.dev', action: 'deny' });
    expect(rules).toContainEqual({ domain: '_api.internal', action: 'deny' });
    expect(rules).toContainEqual({ domain: '*.flycast', action: 'deny' });
  });

  it('given duplicate/empty hosts, should dedupe and drop blanks', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['pypi.org', 'pypi.org', ''] });
    const allows = rules.filter((r) => r.action === 'allow');
    expect(allows).toEqual([{ domain: 'pypi.org', action: 'allow' }]);
  });
});
