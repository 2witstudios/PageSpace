import { describe, it, expect } from 'vitest';
import { isValidProjectName, resolveProjectPath, isValidRepoUrl, PROJECTS_ROOT } from '../project-paths';

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
