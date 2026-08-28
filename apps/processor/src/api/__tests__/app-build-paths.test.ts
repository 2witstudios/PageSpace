import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { safeBuildPath } from '../app-build-paths';

describe('safeBuildPath', () => {
  const root = '/var/build-sources';

  it('joins well-formed segments onto the root', () => {
    expect(safeBuildPath(root, 'abc123', '1700000000000')).toBe(
      path.resolve(root, 'abc123', '1700000000000'),
    );
  });

  it('returns the root itself when called with no segments', () => {
    expect(safeBuildPath(root)).toBe(root);
  });

  it('throws on a segment that walks above the root via ..', () => {
    expect(() => safeBuildPath(root, '..', '..', 'etc', 'passwd')).toThrow(/escapes the build root/);
  });

  it('throws on a segment that resolves to a sibling directory sharing the root as a string prefix', () => {
    // Without the trailing-separator check, "/var/build-sources-evil" would
    // pass a naive `startsWith(root)` test — this is exactly the bug class
    // the trailing path.sep guards against.
    expect(() => safeBuildPath(root, '../build-sources-evil', 'x')).toThrow(/escapes the build root/);
  });

  it('allows a deeply nested well-formed relative path', () => {
    const result = safeBuildPath(root, 'abc123', '1700000000000', 'src', 'index.js');
    expect(result.startsWith(root + path.sep)).toBe(true);
  });
});
