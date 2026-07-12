import { describe, it, expect } from 'vitest';
import {
  isValidProjectName,
  normalizeProjectName,
  resolveProjectPath,
  isValidRepoUrl,
  PROJECTS_ROOT,
} from '../project-paths';

describe('isValidProjectName', () => {
  it('given a plain slug, should accept it', () => {
    expect(isValidProjectName('my-repo')).toBe(true);
    expect(isValidProjectName('my_repo.v2')).toBe(true);
  });

  it('given an empty name, should reject it', () => {
    expect(isValidProjectName('')).toBe(false);
  });

  it('given a name over the length cap, should reject it', () => {
    expect(isValidProjectName('a'.repeat(101))).toBe(false);
  });

  it('given a name starting with a dot, should reject it (hidden dir / traversal)', () => {
    expect(isValidProjectName('.git')).toBe(false);
    expect(isValidProjectName('..')).toBe(false);
    expect(isValidProjectName('...')).toBe(false);
  });

  it('given a name containing a path separator, should reject it', () => {
    expect(isValidProjectName('a/b')).toBe(false);
    expect(isValidProjectName('a\\b')).toBe(false);
  });

  it('given a name that is a traversal attempt, should reject it', () => {
    expect(isValidProjectName('../../etc/passwd')).toBe(false);
  });
});

describe('resolveProjectPath', () => {
  it('given a valid name, should resolve inside PROJECTS_ROOT', () => {
    expect(resolveProjectPath('my-repo')).toBe(`${PROJECTS_ROOT}/my-repo`);
  });

  it('given an invalid name, should return null', () => {
    expect(resolveProjectPath('../escape')).toBeNull();
    expect(resolveProjectPath('')).toBeNull();
  });
});

describe('isValidRepoUrl', () => {
  it('given an https url, should accept it', () => {
    expect(isValidRepoUrl('https://github.com/owner/repo.git')).toBe(true);
  });

  it('given a non-https url, should reject it', () => {
    expect(isValidRepoUrl('git@github.com:owner/repo.git')).toBe(false);
    expect(isValidRepoUrl('http://github.com/owner/repo.git')).toBe(false);
    expect(isValidRepoUrl('file:///etc/passwd')).toBe(false);
  });
});

/** The gnarly-input corpus swept by the invariant + idempotency properties below. */
const GNARLY_INPUTS = [
  '',
  '   ',
  '\t\n',
  '...',
  '.',
  '..',
  '/',
  '-',
  '_',
  '../escape',
  '../../etc/passwd',
  'a\\b',
  '🚀',
  '中文',
  'My Cool Feature',
  'feat/JIRA-123 Fix!!',
  'émoji 🚀 project',
  '.git',
  'a'.repeat(150),
  '日本語',
  '한국어',
  'my-repo',
  'PageSpace',
  'my_repo.v2',
];

describe('normalizeProjectName', () => {
  it.each([
    // [free text a user typed, the directory name it becomes]
    ['My Cool Feature', 'my-cool-feature'],
    ['émoji 🚀 project', 'emoji-project-1v5fxn'],
    ['émoji project', 'emoji-project'],
    ['repo!!!  name', 'repo-name'],
    // A project name is ONE segment — `/` carries no structure here.
    ['feat/JIRA-123 Fix!!', 'feat-jira-123-fix'],
    ['a\\b', 'a-b'],
    // Traversal and hidden-dir attempts slugify into something harmless.
    ['../escape', 'escape'],
    ['../../etc/passwd', 'etc-passwd'],
    ['.git', 'git'],
    // Already-valid names are left alone — including case and `_`, which a
    // directory name may legitimately carry (mirrors normalizeBranchName, where
    // the same pass-through is load-bearing for case-sensitive git refs).
    ['my-repo', 'my-repo'],
    ['PageSpace', 'PageSpace'],
    ['my_repo.v2', 'my_repo.v2'],
    // Nothing sluggable left → the deterministic fallback.
    ['', 'project'],
    ['   ', 'project'],
    ['..', 'project'],
    // The length cap is lossy, so the cut reserves room for a digest — two
    // over-long names must not collapse onto one clone directory.
    ['a'.repeat(150), `${'a'.repeat(93)}-rm68rf`],
    [`${'a'.repeat(99)}-bc`, `${'a'.repeat(93)}-v7hm5m`],
  ])('given %j, should normalize to %j', (input, expected) => {
    expect(normalizeProjectName(input)).toBe(expected);
  });

  it('given names the ASCII charset annihilates, should NOT collapse them onto one directory', () => {
    // Otherwise two distinct repos fight over one clone path and the second is
    // rejected as a duplicate.
    const jp = normalizeProjectName('日本語');
    const kr = normalizeProjectName('한국어');
    const rocket = normalizeProjectName('🚀');

    expect(new Set([jp, kr, rocket, 'project']).size).toBe(4);
    for (const name of [jp, kr, rocket]) {
      expect(isValidProjectName(name)).toBe(true);
      expect(normalizeProjectName(name)).toBe(name);
      expect(resolveProjectPath(name)).toBe(`${PROJECTS_ROOT}/${name}`);
    }
  });

  it.each(GNARLY_INPUTS)(
    'given %j, should produce a name isValidProjectName accepts (the hard invariant)',
    (input) => {
      expect(isValidProjectName(normalizeProjectName(input))).toBe(true);
    },
  );

  it.each(GNARLY_INPUTS)('given %j, should be idempotent', (input) => {
    const once = normalizeProjectName(input);
    expect(normalizeProjectName(once)).toBe(once);
  });

  it.each(GNARLY_INPUTS)('given %j, should resolve to a path confined to PROJECTS_ROOT', (input) => {
    // The normalizer feeds resolveProjectPath — so no input, however hostile,
    // may yield a null path or one outside the root.
    const path = resolveProjectPath(normalizeProjectName(input));
    expect(path).not.toBeNull();
    expect(path).toBe(`${PROJECTS_ROOT}/${normalizeProjectName(input)}`);
  });
});
