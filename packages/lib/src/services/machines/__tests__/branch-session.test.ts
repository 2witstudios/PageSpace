import { describe, it, expect } from 'vitest';
import { deriveBranchSessionKey, isValidBranchName, normalizeBranchName } from '../branch-session';

const base = {
  tenantId: 'tenant-1',
  machineId: 'terminal-1',
  projectName: 'my-repo',
  branchName: 'main',
  secret: 'a'.repeat(32),
};

describe('deriveBranchSessionKey', () => {
  it('given the same inputs, should be deterministic', () => {
    expect(deriveBranchSessionKey(base)).toBe(deriveBranchSessionKey(base));
  });

  it('given two different branch names, should derive two DIFFERENT session keys', () => {
    const a = deriveBranchSessionKey({ ...base, branchName: 'feature-a' });
    const b = deriveBranchSessionKey({ ...base, branchName: 'feature-b' });
    expect(a).not.toBe(b);
  });

  it('given two different projects on the same machine, should derive two different session keys', () => {
    const a = deriveBranchSessionKey({ ...base, projectName: 'repo-a' });
    const b = deriveBranchSessionKey({ ...base, projectName: 'repo-b' });
    expect(a).not.toBe(b);
  });

  it('given two different machines, should derive two different session keys', () => {
    const a = deriveBranchSessionKey({ ...base, machineId: 'terminal-1' });
    const b = deriveBranchSessionKey({ ...base, machineId: 'terminal-2' });
    expect(a).not.toBe(b);
  });

  it('given an empty secret, should throw rather than derive an unkeyed value', () => {
    expect(() => deriveBranchSessionKey({ ...base, secret: '' })).toThrow(/non-empty secret/);
  });

  it('should produce an opaque, namespaced key', () => {
    expect(deriveBranchSessionKey(base)).toMatch(/^pgs-brn-[0-9a-f]{64}$/);
  });
});

describe('isValidBranchName', () => {
  it.each(['main', 'feature/foo', 'fix-123', 'release/1.2.3', 'a', 'a_b-c.d'])(
    'given a well-formed branch name %s, should accept',
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '../etc',
    'a..b',
    '.hidden',
    'feature/.hidden',
    'a/./b',
    'a//b',
    'a.lock',
    'feature/a.lock',
    // git forbids a `.lock` ending on EVERY component, not just the last one.
    'a.lock/b',
    'feature/a.lock/foo',
    '/leading-slash',
    'trailing-slash/',
    'trailing-dot.',
    'has space',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a'.repeat(201),
    // git's reserved symbolic ref — `git checkout -b HEAD` is fatal.
    'HEAD',
  ])('given a malformed branch name %s, should reject', (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});

/**
 * The gnarly-input corpus. Every entry must satisfy the HARD INVARIANT below
 * regardless of what it normalizes to — this is the set the property tests
 * sweep, deliberately wider than the table of pinned expectations.
 */
const GNARLY_INPUTS = [
  '',
  '   ',
  '\t\n',
  '...',
  '/',
  '//',
  '-',
  '_',
  '.',
  '..',
  '../escape',
  '../../etc/passwd',
  '🚀',
  '中文',
  'My Cool Feature',
  'feat/JIRA-123 Fix!!',
  'émoji 🚀 branch',
  'a~b^c:d?e*f[g\\h',
  'hotfix.lock',
  'feature/a.lock',
  'feature/a.lock /foo',
  'a.lock/b',
  'trailing-slash/',
  'trailing-dot.',
  '.hidden',
  'a'.repeat(250),
  `${'x'.repeat(195)}.lockdown`,
  'main',
  'release/1.2.3',
  '日本語',
  '한국어',
  'feature/日本語',
  'Release-2.0',
  'feature_x',
  'HEAD',
];

describe('normalizeBranchName', () => {
  it.each([
    // [free text a user typed, the git ref it becomes]
    ['My Cool Feature', 'my-cool-feature'],
    ['feat/JIRA-123 Fix!!', 'feat/jira-123-fix'],
    // The emoji is content the ASCII charset cannot express, so a digest keeps
    // this apart from a plain `emoji branch` (see the collision tests below).
    ['émoji 🚀 branch', 'emoji-branch-7rmlpe'],
    // ...but an accent alone folds losslessly to ASCII, so no digest is needed.
    ['émoji branch', 'emoji-branch'],
    // Free text git would REJECT still slugifies (lowercased, `_`→`-`).
    ['CAPS FEATURE', 'caps-feature'],
    ['a_b c', 'a-b-c'],
    ['a b  c', 'a-b-c'],
    ['a~b^c:d?e*f[g\\h', 'a-b-c-d-e-f-g-h'],
    // Already-valid refs are left alone — `/` is structural, single dots survive.
    ['main', 'main'],
    ['feature/foo', 'feature/foo'],
    ['release/1.2.3', 'release/1.2.3'],
    // ...INCLUDING case and `_`, both of which git accepts. Slugifying these
    // would be actively harmful — see the regression test below.
    ['Release-2.0', 'Release-2.0'],
    ['feature_x', 'feature_x'],
    ['JIRA-123', 'JIRA-123'],
    // ...but NOT git's reserved symbolic ref, which slugifies to a legal branch.
    ['HEAD', 'head'],
    // Traversal and empty segments collapse away rather than erroring.
    ['../escape', 'escape'],
    ['a//b', 'a/b'],
    ['a..b', 'a-b'],
    ['a/./b', 'a/b'],
    ['.hidden', 'hidden'],
    ['-leading-dash', 'leading-dash'],
    ['/leading-slash', 'leading-slash'],
    ['trailing-slash/', 'trailing-slash'],
    ['trailing-dot.', 'trailing-dot'],
    ['feature/ -foo- ', 'feature/foo'],
    // `.lock` is forbidden at the end of EVERY slash-separated component, not
    // just the ref as a whole — `git checkout -b feature/a.lock/foo` is fatal.
    ['hotfix.lock', 'hotfix-lock'],
    ['feature/a.lock', 'feature/a-lock'],
    ['a.lock/b', 'a-lock/b'],
    ['feature/a.lock /foo', 'feature/a-lock/foo'],
    // Nothing sluggable left → the deterministic fallback.
    ['', 'branch'],
    ['   ', 'branch'],
    ['...', 'branch'],
    ['//', 'branch'],
    // The length cap is itself lossy — two different over-long names would cut
    // to the SAME ref — so the cut reserves room for a digest of the original.
    ['a'.repeat(250), `${'a'.repeat(193)}-62a0y7`],
    [`${'a'.repeat(199)}-b-c`, `${'a'.repeat(192)}-1x5nok5`],
    [`${'x'.repeat(195)}.lockdown`, `${'x'.repeat(193)}-px8620`],
  ])('given %j, should normalize to %j', (input, expected) => {
    expect(normalizeBranchName(input)).toBe(expected);
  });

  it.each(GNARLY_INPUTS)(
    'given %j, should produce a name isValidBranchName accepts (the hard invariant)',
    (input) => {
      expect(isValidBranchName(normalizeBranchName(input))).toBe(true);
    },
  );

  it.each(GNARLY_INPUTS)('given %j, should be idempotent', (input) => {
    const once = normalizeBranchName(input);
    expect(normalizeBranchName(once)).toBe(once);
  });

  it('given any already-valid name, should be a fixed point (normalizing it changes nothing)', () => {
    for (const name of ['main', 'feature/foo', 'fix-123', 'release/1.2.3', 'a', 'a-b-c.d']) {
      expect(normalizeBranchName(name)).toBe(name);
    }
  });

  it('given a name whose non-ASCII part is only PART of it, should still not collide', () => {
    // The subtle one: `日本語 feature` slugifies to `feature` — an entirely
    // different branch that may already exist and belong to someone else. It is
    // not enough to digest names the charset annihilates ENTIRELY; any destroyed
    // identity-bearing content must disambiguate.
    expect(normalizeBranchName('日本語 feature')).not.toBe('feature');
    expect(normalizeBranchName('🚀 launch')).not.toBe('launch');
    expect(normalizeBranchName('feature/日本語-fix')).not.toBe('feature/fix');
    expect(normalizeBranchName('日本語 feature')).not.toBe(normalizeBranchName('中文 feature'));

    // Losing ASCII punctuation stays lossless-enough — these SHOULD be one branch.
    expect(normalizeBranchName('a b')).toBe(normalizeBranchName('a!b'));
  });

  it('given two over-long names with a common prefix, should NOT cut them onto one ref', () => {
    // The length cap is lossy too: both used to become 200 `a`s.
    const long = 'a'.repeat(250);
    const longer = `${'a'.repeat(250)}-different`;
    expect(normalizeBranchName(long)).not.toBe(normalizeBranchName(longer));
    expect(normalizeBranchName(long).length).toBeLessThanOrEqual(200);
    expect(normalizeBranchName(longer).length).toBeLessThanOrEqual(200);
    expect(isValidBranchName(normalizeBranchName(longer))).toBe(true);
  });

  it('given names the ASCII charset annihilates, should NOT collapse them onto one ref', () => {
    // THE severe case. The branch name IS the branch-terminal's identity: it is
    // hashed into the Sprite session key and is the store's lookup key. If every
    // non-Latin name fell back to `branch`, spawning `日本語` and then `한국어`
    // would report `resumed: true` and hand the second user the FIRST user's
    // Sprite and filesystem. Each keeps a deterministic digest token instead.
    const jp = normalizeBranchName('日本語');
    const kr = normalizeBranchName('한국어');
    const rocket = normalizeBranchName('🚀');

    expect(new Set([jp, kr, rocket, 'branch']).size).toBe(4);
    for (const name of [jp, kr, rocket]) {
      expect(isValidBranchName(name)).toBe(true);
      expect(normalizeBranchName(name)).toBe(name);
    }
    // Deterministic across calls — the same input must always find the same branch.
    expect(normalizeBranchName('日本語')).toBe(jp);
    // ...and whitespace around it is not a different branch.
    expect(normalizeBranchName('  日本語  ')).toBe(jp);
  });

  it('given a wiped segment inside a path, should keep a token rather than silently becoming its parent', () => {
    // `feature/日本語` must not collapse to plain `feature` — that would collide
    // with a real `feature` branch and attach the user to someone else's work.
    const nested = normalizeBranchName('feature/日本語');
    expect(nested).not.toBe('feature');
    expect(nested.startsWith('feature/')).toBe(true);
    expect(isValidBranchName(nested)).toBe(true);
    // Structural noise still vanishes — this is what keeps `../escape` → `escape`.
    expect(normalizeBranchName('feature/../foo')).toBe('feature/foo');
  });

  it('given a name git already accepts, should NOT rewrite it — case and `_` are load-bearing', () => {
    // REGRESSION GUARD. Git refs are case-sensitive. Slugifying `Release-2.0`
    // to `release-2.0` made `git checkout -b release-2.0 origin/release-2.0`
    // miss the real upstream branch, and cloneAndCheckoutBranch's fallback then
    // silently created a NEW EMPTY branch off HEAD while origin/Release-2.0 sat
    // untouched. Normalization exists to accept text git would REJECT — never to
    // rewrite text git would have honored.
    expect(normalizeBranchName('Release-2.0')).toBe('Release-2.0');
    expect(normalizeBranchName('feature_x')).toBe('feature_x');
    expect(normalizeBranchName('feature/JIRA-123')).toBe('feature/JIRA-123');
  });

  it('given two free-text spellings of the same name, should collapse them to the SAME ref', () => {
    // Consequential: the session key is derived from the normalized name, so
    // these must land on one branch-terminal, not two. Note this only applies to
    // text git REJECTS — `my---cool___feature` is a legal ref, so it passes
    // through as itself and is genuinely a different branch.
    expect(normalizeBranchName('My Cool Feature')).toBe('my-cool-feature');
    expect(normalizeBranchName('my  cool   feature!!')).toBe('my-cool-feature');
    expect(normalizeBranchName('My Cool Feature')).toBe(normalizeBranchName('my  cool   feature!!'));
  });
});
