import { describe, it, expect } from 'vitest';
import { deriveBranchSessionKey, isValidBranchName } from '../branch-session';

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
  ])('given a malformed branch name %s, should reject', (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});
