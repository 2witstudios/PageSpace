import { describe, it, expect } from 'vitest';
import { resolveSandboxPath, SANDBOX_ROOT } from '../sandbox-paths';

describe('resolveSandboxPath', () => {
  it('given a simple relative path, should resolve under the sandbox root', () => {
    expect(resolveSandboxPath('notes.txt')).toBe(`${SANDBOX_ROOT}/notes.txt`);
  });

  it('given a nested relative path, should resolve under the sandbox root', () => {
    expect(resolveSandboxPath('a/b/c.txt')).toBe(`${SANDBOX_ROOT}/a/b/c.txt`);
  });

  it('given a parent-traversal path, should reject it', () => {
    expect(resolveSandboxPath('../../etc/passwd')).toBeNull();
  });

  it('given an absolute path, should reject it (no escaping the root)', () => {
    expect(resolveSandboxPath('/etc/passwd')).toBeNull();
  });

  it('given a URL-encoded traversal, should reject it', () => {
    expect(resolveSandboxPath('%2e%2e/secret')).toBeNull();
  });

  it('given an empty or non-string path, should reject it', () => {
    expect(resolveSandboxPath('')).toBeNull();
    expect(resolveSandboxPath(undefined as unknown as string)).toBeNull();
  });
});
