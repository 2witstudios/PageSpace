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
  'my-repo',
];

describe('normalizeProjectName', () => {
  it.each([
    // [free text a user typed, the directory name it becomes]
    ['My Cool Feature', 'my-cool-feature'],
    ['PageSpace', 'pagespace'],
    ['émoji 🚀 project', 'emoji-project'],
    ['my_repo.v2', 'my-repo.v2'],
    ['repo---name', 'repo-name'],
    // A project name is ONE segment — `/` carries no structure here.
    ['feat/JIRA-123 Fix!!', 'feat-jira-123-fix'],
    ['a\\b', 'a-b'],
    // Traversal and hidden-dir attempts slugify into something harmless.
    ['../escape', 'escape'],
    ['../../etc/passwd', 'etc-passwd'],
    ['.git', 'git'],
    // Already-valid slugs are left alone.
    ['my-repo', 'my-repo'],
    // Nothing sluggable left → the deterministic fallback.
    ['', 'project'],
    ['   ', 'project'],
    ['..', 'project'],
    ['🚀', 'project'],
    // Length cap, with the separator the cut exposes trimmed off.
    ['a'.repeat(150), 'a'.repeat(100)],
    [`${'a'.repeat(99)}-bc`, 'a'.repeat(99)],
  ])('given %j, should normalize to %j', (input, expected) => {
    expect(normalizeProjectName(input)).toBe(expected);
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
