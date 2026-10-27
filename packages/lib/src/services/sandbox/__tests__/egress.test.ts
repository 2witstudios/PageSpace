import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  buildSpriteNetworkPolicy,
  sanitizeEgressAllowlist,
  buildInternalSurfaceDenyRules,
} from '../egress';
import type { PolicyRule } from '@fly/sprites';

const hasInclude = (rules: PolicyRule[]): boolean => rules.some((r) => r.include !== undefined);

describe('buildSpriteNetworkPolicy — allowlist mode', () => {
  it('empty allowlist is pure deny-all', () => {
    assert({
      given: 'an empty allowlist',
      should: 'be a pure deny-all policy (default-deny egress)',
      actual: buildSpriteNetworkPolicy({ egressAllowlist: [] }),
      expected: { rules: [{ domain: '*', action: 'deny' }] },
    });
  });

  it('no input defaults to deny-all', () => {
    assert({
      given: 'no input',
      should: 'default to deny-all',
      actual: buildSpriteNetworkPolicy(),
      expected: { rules: [{ domain: '*', action: 'deny' }] },
    });
  });

  it('empty allowlist does not lean on the defaults preset', () => {
    assert({
      given: 'an empty allowlist',
      should: 'not emit the include:defaults preset (pure deny-all, no preset semantics)',
      actual: hasInclude(buildSpriteNetworkPolicy({ egressAllowlist: [] }).rules),
      expected: false,
    });
  });

  it('widened allowlist allows the hosts and terminates in deny-all', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: ['registry.npmjs.org', 'pypi.org'],
    });
    assert({
      given: 'registry hosts',
      should: 'emit an allow rule for each host',
      actual: rules.filter((r) => r.action === 'allow'),
      expected: [
        { domain: 'registry.npmjs.org', action: 'allow' },
        { domain: 'pypi.org', action: 'allow' },
      ],
    });
    assert({
      given: 'registry hosts',
      should: 'terminate with a deny-all catch-all as the final rule',
      actual: rules[rules.length - 1],
      expected: { domain: '*', action: 'deny' },
    });
  });

  it('widened allowlist protects the internal surface via EXPLICIT denies, not include:defaults', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['registry.npmjs.org'] });
    assert({
      given: 'a widened allowlist',
      should: 'never emit the include:defaults preset (it is an allowlist convenience, not a deny)',
      actual: hasInclude(rules),
      expected: false,
    });
    assert({
      given: 'a widened allowlist',
      should: 'emit the explicit internal-surface deny rules',
      actual: buildInternalSurfaceDenyRules().every((deny) =>
        rules.some((r) => r.domain === deny.domain && r.action === 'deny'),
      ),
      expected: true,
    });
  });

  it('widened allowlist orders the internal denies BEFORE any allow', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['registry.npmjs.org'] });
    const lastInternalDenyIdx = rules.reduce(
      (acc, r, i) => (r.action === 'deny' && r.domain !== '*' ? i : acc),
      -1,
    );
    const firstAllowIdx = rules.findIndex((r) => r.action === 'allow');
    assert({
      given: 'a widened allowlist',
      should: 'place every explicit internal deny ahead of the first allow',
      actual: lastInternalDenyIdx >= 0 && lastInternalDenyIdx < firstAllowIdx,
      expected: true,
    });
  });

  it('dedupes and drops blank hosts', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['pypi.org', 'pypi.org', ''] });
    assert({
      given: 'duplicate and empty hosts',
      should: 'dedupe and drop blanks',
      actual: rules.filter((r) => r.action === 'allow'),
      expected: [{ domain: 'pypi.org', action: 'allow' }],
    });
  });

  it('drops a bare "*" so it cannot allow-all past the terminating deny', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressAllowlist: ['*', 'registry.npmjs.org'] });
    assert({
      given: 'a bare global-wildcard "*" allow entry',
      should: 'drop it (the global wildcard would defeat deny-by-default)',
      actual: rules.some((r) => r.action === 'allow' && r.domain === '*'),
      expected: false,
    });
    assert({
      given: 'a bare "*" alongside a real host',
      should: 'still allow the real host and terminate in deny-all',
      actual: {
        allowsHost: rules.some((r) => r.domain === 'registry.npmjs.org' && r.action === 'allow'),
        terminatingDeny: rules[rules.length - 1],
      },
      expected: {
        allowsHost: true,
        terminatingDeny: { domain: '*', action: 'deny' },
      },
    });
  });

  it('an allowlist of only invalid entries collapses to pure deny-all', () => {
    assert({
      given: 'an allowlist of only invalid entries',
      should: 'collapse to pure deny-all',
      actual: buildSpriteNetworkPolicy({
        egressAllowlist: ['*', '10.0.0.1', '::1', 'https://evil.com', 'host:443', 'a/b'],
      }),
      expected: { rules: [{ domain: '*', action: 'deny' }] },
    });
  });

  it('accepts and emits a subdomain-wildcard allow entry', () => {
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: ['*.githubusercontent.com', 'github.com'],
    });
    assert({
      given: 'a subdomain-wildcard allow entry',
      should: 'emit it verbatim as an allow rule (per the documented grammar)',
      actual: rules.filter((r) => r.action === 'allow'),
      expected: [
        { domain: '*.githubusercontent.com', action: 'allow' },
        { domain: 'github.com', action: 'allow' },
      ],
    });
  });

  it('explicit egressMode: allowlist behaves identically to the default path', () => {
    assert({
      given: 'egressMode: allowlist explicitly',
      should: 'behave identically to the default (no-mode) path',
      actual: buildSpriteNetworkPolicy({ egressMode: 'allowlist', egressAllowlist: ['pypi.org'] }),
      expected: buildSpriteNetworkPolicy({ egressAllowlist: ['pypi.org'] }),
    });
  });

  it('never emits an allow rule for an internal-surface host (no specificity bypass)', () => {
    // An exact/more-specific ALLOW would beat the wildcard internal deny under the
    // documented precedence, so a caller-supplied internal host must be dropped.
    const { rules } = buildSpriteNetworkPolicy({
      egressAllowlist: [
        'foo.internal',
        'evil.flycast',
        'sub.fly.storage.tigris.dev',
        't3.tigrisfiles.io',
        '*.internal',
        'registry.npmjs.org',
      ],
    });
    assert({
      given: 'an allowlist mixing internal-surface hosts with a legit registry',
      should: 'allow only the legit host and never allow any internal-surface host',
      actual: rules.filter((r) => r.action === 'allow'),
      expected: [{ domain: 'registry.npmjs.org', action: 'allow' }],
    });
  });

  it('collapses to pure deny-all when the allowlist is only internal-surface hosts', () => {
    assert({
      given: 'an allowlist of only internal-surface hosts',
      should: 'drop them all and collapse to pure deny-all',
      actual: buildSpriteNetworkPolicy({
        egressAllowlist: ['foo.internal', '_api.internal', '*.flycast', 'fly.storage.tigris.dev'],
      }),
      expected: { rules: [{ domain: '*', action: 'deny' }] },
    });
  });
});

describe('buildSpriteNetworkPolicy — open mode', () => {
  it('emits internal denies then a single allow-all, with no defaults preset', () => {
    assert({
      given: 'egressMode: open',
      should: 'be [explicit internal denies, allow-all] — no include:defaults, no terminating deny',
      actual: buildSpriteNetworkPolicy({ egressMode: 'open' }),
      expected: {
        rules: [...buildInternalSurfaceDenyRules(), { domain: '*', action: 'allow' }],
      },
    });
  });

  it('does NOT duplicate include:defaults alongside the global allow-all', () => {
    assert({
      given: 'egressMode: open (which already emits a global {domain:"*",action:"allow"})',
      should: 'not also emit the redundant include:defaults preset',
      actual: hasInclude(buildSpriteNetworkPolicy({ egressMode: 'open' }).rules),
      expected: false,
    });
  });

  it('orders the explicit internal denies before the allow-all', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    const allowAllIdx = rules.findIndex((r) => r.domain === '*' && r.action === 'allow');
    const lastInternalDenyIdx = rules.reduce(
      (acc, r, i) => (r.action === 'deny' && r.domain !== '*' ? i : acc),
      -1,
    );
    assert({
      given: 'egressMode: open',
      should: 'place every explicit internal deny before the allow-all',
      actual: lastInternalDenyIdx >= 0 && lastInternalDenyIdx < allowAllIdx,
      expected: true,
    });
  });

  it('keeps an explicit _api.internal deny (does not lean on any preset)', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    assert({
      given: 'egressMode: open',
      should: 'keep an explicit _api.internal deny',
      actual: rules.some((r) => r.domain === '_api.internal' && r.action === 'deny'),
      expected: true,
    });
  });

  it('contains a global allow-all and no terminating deny-all', () => {
    const { rules } = buildSpriteNetworkPolicy({ egressMode: 'open' });
    assert({
      given: 'egressMode: open',
      should: 'include a global allow-all and NOT a terminating deny-all',
      actual: {
        allowAll: rules.some((r) => r.domain === '*' && r.action === 'allow'),
        denyAll: rules.some((r) => r.domain === '*' && r.action === 'deny'),
      },
      expected: { allowAll: true, denyAll: false },
    });
  });

  it('ignores any egressAllowlist in open mode', () => {
    assert({
      given: 'egressMode: open with an egressAllowlist',
      should: 'ignore the allowlist entirely',
      actual: buildSpriteNetworkPolicy({
        egressMode: 'open',
        egressAllowlist: ['registry.npmjs.org'],
      }),
      expected: {
        rules: [...buildInternalSurfaceDenyRules(), { domain: '*', action: 'allow' }],
      },
    });
  });
});

describe('buildInternalSurfaceDenyRules', () => {
  it('emits deny rules for the Fly internal surface', () => {
    // Exact-membership set over our own built rules (not URL substring matching).
    const denied = new Set(buildInternalSurfaceDenyRules().map((r) => r.domain));
    assert({
      given: 'no input',
      should: 'deny the core internal-surface names',
      actual: {
        api: denied.has('_api.internal'),
        internal: denied.has('*.internal'),
        flycast: denied.has('*.flycast'),
        tigris: denied.has('fly.storage.tigris.dev') && denied.has('t3.tigrisfiles.io'),
      },
      expected: { api: true, internal: true, flycast: true, tigris: true },
    });
  });

  it('denies exact apex hostnames as well as wildcard children', () => {
    // Exact-membership set over our own built rules (not URL substring matching).
    const denied = new Set(buildInternalSurfaceDenyRules().map((r) => r.domain));
    assert({
      given: 'apex hosts a subdomain wildcard would not match',
      should: 'deny the exact apex hostnames too',
      actual: {
        flycast: denied.has('flycast'),
        tigrisApex: denied.has('fly.storage.tigris.dev'),
        tigrisFiles: denied.has('t3.tigrisfiles.io'),
      },
      expected: { flycast: true, tigrisApex: true, tigrisFiles: true },
    });
  });

  it('every emitted rule is a deny', () => {
    assert({
      given: 'the internal-surface deny builder',
      should: 'only ever emit deny rules',
      actual: buildInternalSurfaceDenyRules().every((r) => r.action === 'deny'),
      expected: true,
    });
  });

  it('does not depend on the include:defaults preset', () => {
    assert({
      given: 'the internal-surface deny builder',
      should: 'never emit an include rule (explicit denies only)',
      actual: buildInternalSurfaceDenyRules().some((r) => r.include !== undefined),
      expected: false,
    });
  });

  it('returns a fresh, clone-safe array each call', () => {
    const a = buildInternalSurfaceDenyRules();
    a.push({ domain: 'evil.test', action: 'allow' });
    assert({
      given: 'a mutated returned array',
      should: 'not affect a fresh build (no shared mutation)',
      actual: buildInternalSurfaceDenyRules().some((r) => r.domain === 'evil.test'),
      expected: false,
    });
  });
});

describe('sanitizeEgressAllowlist', () => {
  it('keeps literal hostnames, trimmed and lowercased', () => {
    assert({
      given: 'literal hostnames with surrounding space and mixed case',
      should: 'keep them trimmed and lowercased',
      actual: sanitizeEgressAllowlist([' Registry.NPMJS.org ', 'pypi.org']),
      expected: ['registry.npmjs.org', 'pypi.org'],
    });
  });

  it('keeps subdomain-wildcard hostnames per the documented grammar', () => {
    assert({
      given: 'subdomain-wildcard hostnames',
      should: 'keep them (trimmed, lowercased)',
      actual: sanitizeEgressAllowlist([' *.GithubUserContent.com ', '*.pkg.dev']),
      expected: ['*.githubusercontent.com', '*.pkg.dev'],
    });
  });

  it('drops the bare global wildcard, IP literals, and non-host strings', () => {
    assert({
      given: 'a bare "*", IP literals, and non-host strings',
      should: 'drop all of them',
      actual: sanitizeEgressAllowlist([
        '*',
        '1.2.3.4',
        '2001:db8::1',
        'https://example.com',
        'example.com/path',
        'example.com:8080',
        '*.',
        '*.*',
        '*.1.2.3.4',
        '',
        '   ',
      ]),
      expected: [],
    });
  });

  it('dedupes after canonicalization', () => {
    assert({
      given: 'the same host in different case',
      should: 'dedupe after canonicalization',
      actual: sanitizeEgressAllowlist(['Example.com', 'example.com', '*.Example.com', '*.example.com']),
      expected: ['example.com', '*.example.com'],
    });
  });

  it('drops entries that target the internal surface (exact, subdomain, or wildcard)', () => {
    assert({
      given: 'allowlist entries inside the internal-surface zones',
      should: 'drop every one so no allow can beat the wildcard internal deny',
      actual: sanitizeEgressAllowlist([
        'foo.internal',
        '_api.internal',
        '*.internal',
        'flycast',
        'evil.flycast',
        '*.flycast',
        'fly.storage.tigris.dev',
        'sub.fly.storage.tigris.dev',
        '*.fly.storage.tigris.dev',
        't3.tigrisfiles.io',
        'x.t3.tigrisfiles.io',
      ]),
      expected: [],
    });
  });

  it('keeps public hosts that merely share a parent domain with an internal zone', () => {
    // A non-wildcard sibling host only matches itself, so it cannot reach the
    // internal zone and is fine.
    assert({
      given: 'a public non-wildcard host that shares a parent domain but is not an internal zone',
      should: 'keep it',
      actual: sanitizeEgressAllowlist(['other.tigrisfiles.io', 'notinternal.com']),
      expected: ['other.tigrisfiles.io', 'notinternal.com'],
    });
  });

  it('drops ANCESTOR wildcards that would match into an internal zone', () => {
    // A wildcard `*.base` matches subdomains of `base`; if an internal zone is a
    // subdomain of `base`, the allow overlaps the internal surface (same
    // wildcard tier as the deny, which the docs do not tie-break) and must go.
    assert({
      given: 'wildcard entries whose base is an ancestor of an internal zone',
      should: 'drop every one so no allow can reach the internal object-storage surface',
      actual: sanitizeEgressAllowlist([
        '*.tigrisfiles.io', // ancestor of t3.tigrisfiles.io
        '*.tigris.dev', // ancestor of fly.storage.tigris.dev
        '*.storage.tigris.dev', // ancestor of fly.storage.tigris.dev
      ]),
      expected: [],
    });
  });

  it('keeps legit subdomain wildcards that do not overlap any internal zone', () => {
    assert({
      given: 'subdomain wildcards for public hosts with no internal zone beneath them',
      should: 'keep them',
      actual: sanitizeEgressAllowlist(['*.githubusercontent.com', '*.pkg.dev', '*.npmjs.org']),
      expected: ['*.githubusercontent.com', '*.pkg.dev', '*.npmjs.org'],
    });
  });

  it('drops bare single-label TLD wildcards uniformly (no per-TLD asymmetry)', () => {
    // `*.com`/`*.dev`/`*.io` have a single-label base, which HOSTNAME_RE rejects
    // before the internal-zone check — so all are dropped as invalid, whether or
    // not a Fly internal zone happens to sit under that TLD. Only a MULTI-label
    // wildcard reaches the ancestor-overlap rule (see the ancestor test above).
    assert({
      given: 'bare single-label TLD wildcards, with and without an internal zone under them',
      should: 'drop all of them uniformly (a multi-label base is required)',
      actual: sanitizeEgressAllowlist(['*.dev', '*.io', '*.com']),
      expected: [],
    });
  });
});
