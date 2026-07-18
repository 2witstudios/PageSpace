import { describe, it, expect } from 'vitest';
import { filesScopeKey, filesScopeSearchParams } from '../files-scope';

describe('filesScopeKey', () => {
  it('given root scope, should return the bare literal "root"', () => {
    expect(filesScopeKey({ kind: 'root' })).toBe('root');
  });

  it('given branch scope, should return a JSON-encoded key distinct from "root"', () => {
    const key = filesScopeKey({ kind: 'branch', projectName: 'proj', branchName: 'main' });
    expect(key).not.toBe('root');
    expect(key).toBe(JSON.stringify(['branch', 'proj', 'main']));
  });

  it('given a branch name containing "/", should still never collide with the root key', () => {
    const key = filesScopeKey({ kind: 'branch', projectName: 'proj', branchName: 'feature/root' });
    expect(key).not.toBe('root');
  });

  it('given two different branches, should produce different keys', () => {
    const a = filesScopeKey({ kind: 'branch', projectName: 'proj', branchName: 'main' });
    const b = filesScopeKey({ kind: 'branch', projectName: 'proj', branchName: 'dev' });
    expect(a).not.toBe(b);
  });

  it('given the same scope twice, should return a stable, equal key', () => {
    const scope = { kind: 'branch' as const, projectName: 'proj', branchName: 'main' };
    expect(filesScopeKey(scope)).toBe(filesScopeKey({ ...scope }));
  });
});

describe('filesScopeSearchParams', () => {
  it('given root scope, should include machineId but omit projectName/branchName', () => {
    const params = filesScopeSearchParams('machine-1', { kind: 'root' });
    expect(params.get('machineId')).toBe('machine-1');
    expect(params.has('projectName')).toBe(false);
    expect(params.has('branchName')).toBe(false);
  });

  it('given branch scope, should include machineId, projectName, and branchName', () => {
    const params = filesScopeSearchParams('machine-1', { kind: 'branch', projectName: 'proj', branchName: 'main' });
    expect(params.get('machineId')).toBe('machine-1');
    expect(params.get('projectName')).toBe('proj');
    expect(params.get('branchName')).toBe('main');
  });
});
