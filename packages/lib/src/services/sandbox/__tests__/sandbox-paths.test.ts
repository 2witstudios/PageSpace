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

  it('given an absolute path under /workspace, should resolve the same as the equivalent relative path', () => {
    expect(resolveSandboxPath('/workspace/PageSpace/apps/web/foo.ts')).toBe(
      resolveSandboxPath('PageSpace/apps/web/foo.ts'),
    );
  });

  it('given the bare sandbox root with no trailing content, should resolve to the root', () => {
    expect(resolveSandboxPath('/workspace')).toBe(SANDBOX_ROOT);
  });

  it('given an absolute path NOT prefixed with /workspace, should still reject it', () => {
    expect(resolveSandboxPath('/etc/passwd')).toBeNull();
    expect(resolveSandboxPath('/workspace-evil/foo.ts')).toBeNull();
  });

  it('given a traversal attempt appended after the /workspace prefix, should still reject it', () => {
    expect(resolveSandboxPath('/workspace/../../etc/passwd')).toBeNull();
  });

  it('given a URL-encoded attempt to smuggle the /workspace prefix, should still reject it', () => {
    expect(resolveSandboxPath('%2Fworkspace%2F..%2F..%2Fetc%2Fpasswd')).toBeNull();
  });

  it('given a doubled separator right after the /workspace prefix, should still resolve (not misread the extra slash as a fresh absolute segment)', () => {
    expect(resolveSandboxPath('/workspace//PageSpace/foo.ts')).toBe(
      resolveSandboxPath('PageSpace/foo.ts'),
    );
  });
});
