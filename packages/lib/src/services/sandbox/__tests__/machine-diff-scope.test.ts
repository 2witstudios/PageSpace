import { describe, it, expect } from 'vitest';
import {
  diffScopeSides,
  isMachineDiffScope,
  isMainBranchName,
  parseNameStatusZ,
  parseStatusPorcelainZ,
  resolveDiffScope,
  DIFF_BASE_REF,
  type MachineDiffScope,
  type MachineDiffScopeResolution,
  type MachineDiffSides,
} from '../machine-diff-scope';

/**
 * The pure core of the Diff tab's 3-way scope service — everything here runs
 * with ZERO mocks: no sandbox, no DI, no fakes. The tables below pin the
 * exact git argv per scope and the notApplicable rule on the main branch.
 */

describe('resolveDiffScope', () => {
  const table: Array<{
    name: string;
    branchName: string;
    isMainBranch: boolean;
    scope: MachineDiffScope;
    expected: MachineDiffScopeResolution;
  }> = [
    {
      name: 'uncommitted on a feature branch → git status --porcelain -z',
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'uncommitted',
      expected: { gitArgs: ['status', '--porcelain', '-z'] },
    },
    {
      name: 'uncommitted on the main branch stays applicable (working tree vs last commit is always meaningful)',
      branchName: 'master',
      isMainBranch: true,
      scope: 'uncommitted',
      expected: { gitArgs: ['status', '--porcelain', '-z'] },
    },
    {
      name: 'committed on a feature branch → three-dot diff (merge-base..HEAD) against the default branch',
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'committed',
      expected: { gitArgs: ['diff', '--name-status', '-z', `${DIFF_BASE_REF}...HEAD`] },
    },
    {
      name: 'committed on the main branch → notApplicable (merge-base with itself is empty)',
      branchName: 'master',
      isMainBranch: true,
      scope: 'committed',
      expected: { notApplicable: true },
    },
    {
      name: 'branch on a feature branch → --merge-base working-tree diff against the default branch',
      branchName: 'feature/x',
      isMainBranch: false,
      scope: 'branch',
      expected: { gitArgs: ['diff', '--name-status', '-z', '--merge-base', DIFF_BASE_REF] },
    },
    {
      name: 'branch on the main branch → notApplicable',
      branchName: 'main',
      isMainBranch: true,
      scope: 'branch',
      expected: { notApplicable: true },
    },
  ];

  it.each(table)('$name', ({ branchName, isMainBranch, scope, expected }) => {
    expect(resolveDiffScope(branchName, isMainBranch, scope)).toEqual(expected);
  });

  it.each([
    { branchName: 'master', scope: 'committed' as const },
    { branchName: 'master', scope: 'branch' as const },
    { branchName: 'main', scope: 'committed' as const },
    { branchName: 'main', scope: 'branch' as const },
  ])(
    'still returns notApplicable for $scope when the caller passes a stale isMainBranch=false for "$branchName"',
    ({ branchName, scope }) => {
      expect(resolveDiffScope(branchName, false, scope)).toEqual({ notApplicable: true });
    },
  );

  it('never emits empty gitArgs — an applicable scope always resolves to a runnable command', () => {
    for (const scope of ['uncommitted', 'committed', 'branch'] as const) {
      const resolution = resolveDiffScope('feature/x', false, scope);
      expect('gitArgs' in resolution && resolution.gitArgs.length > 0).toBe(true);
    }
  });
});

describe('isMainBranchName', () => {
  it.each([
    { branchName: 'master', expected: true },
    { branchName: 'main', expected: true },
    { branchName: 'Master', expected: false }, // case-sensitive, matching the codebase convention
    { branchName: 'main-2', expected: false },
    { branchName: 'feature/main', expected: false },
    { branchName: '', expected: false },
  ])('"$branchName" → $expected', ({ branchName, expected }) => {
    expect(isMainBranchName(branchName)).toBe(expected);
  });
});

describe('isMachineDiffScope', () => {
  it.each([
    { value: 'uncommitted', expected: true },
    { value: 'committed', expected: true },
    { value: 'branch', expected: true },
    { value: 'all', expected: false },
    { value: '', expected: false },
  ])('"$value" → $expected', ({ value, expected }) => {
    expect(isMachineDiffScope(value)).toBe(expected);
  });
});

describe('diffScopeSides', () => {
  const table: Array<{ scope: MachineDiffScope; expected: MachineDiffSides }> = [
    { scope: 'uncommitted', expected: { original: 'head-blob', modified: 'working-tree' } },
    { scope: 'committed', expected: { original: 'merge-base-blob', modified: 'head-blob' } },
    { scope: 'branch', expected: { original: 'merge-base-blob', modified: 'working-tree' } },
  ];

  it.each(table)('$scope → original from $expected.original, modified from $expected.modified', ({ scope, expected }) => {
    expect(diffScopeSides(scope)).toEqual(expected);
  });
});

describe('parseStatusPorcelainZ', () => {
  it('returns [] for empty output (clean working tree)', () => {
    expect(parseStatusPorcelainZ('')).toEqual([]);
  });

  it('parses modified / staged / untracked / deleted entries', () => {
    const stdout = ' M src/a.ts\0M  src/b.ts\0?? new.ts\0 D gone.ts\0D  staged-gone.ts\0A  added.ts\0';
    expect(parseStatusPorcelainZ(stdout)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'modified' },
      { path: 'new.ts', status: 'added' },
      { path: 'gone.ts', status: 'deleted' },
      { path: 'staged-gone.ts', status: 'deleted' },
      { path: 'added.ts', status: 'added' },
    ]);
  });

  it('parses a rename entry — target path first, NUL-separated source second', () => {
    const stdout = 'R  renamed-to.ts\0renamed-from.ts\0 M other.ts\0';
    expect(parseStatusPorcelainZ(stdout)).toEqual([
      { path: 'renamed-to.ts', status: 'renamed', previousPath: 'renamed-from.ts' },
      { path: 'other.ts', status: 'modified' },
    ]);
  });

  it('reports a rename that was then deleted in the worktree as deleted (D wins over R)', () => {
    expect(parseStatusPorcelainZ('RD new.ts\0old.ts\0')).toEqual([
      { path: 'new.ts', status: 'deleted', previousPath: 'old.ts' },
    ]);
  });

  it('handles paths with spaces and non-ASCII without quoting (-z never C-quotes)', () => {
    const stdout = ' M dir with space/naïve file.ts\0?? über.md\0';
    expect(parseStatusPorcelainZ(stdout)).toEqual([
      { path: 'dir with space/naïve file.ts', status: 'modified' },
      { path: 'über.md', status: 'added' },
    ]);
  });

  it('drops a truncated trailing entry instead of guessing (output-cap cut)', () => {
    // every complete -z entry ends in NUL, so a non-empty final token is a cut field:
    expect(parseStatusPorcelainZ(' M full.ts\0 M par')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    expect(parseStatusPorcelainZ(' M full.ts\0 M')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    // a rename cut before its source field is dropped:
    expect(parseStatusPorcelainZ(' M full.ts\0R  new.ts\0old')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    expect(parseStatusPorcelainZ(' M full.ts\0R  new.ts\0')).toEqual([{ path: 'full.ts', status: 'modified' }]);
  });
});

describe('parseNameStatusZ', () => {
  it('returns [] for empty output (no commits diverge)', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });

  it('parses added / modified / deleted / type-change entries', () => {
    const stdout = 'M\0src/a.ts\0A\0src/new.ts\0D\0src/gone.ts\0T\0link.ts\0';
    expect(parseNameStatusZ(stdout)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'link.ts', status: 'modified' },
    ]);
  });

  it('parses a rename entry — source path first, target second (reverse of status --porcelain -z)', () => {
    const stdout = 'R100\0old/name.ts\0new/name.ts\0M\0other.ts\0';
    expect(parseNameStatusZ(stdout)).toEqual([
      { path: 'new/name.ts', status: 'renamed', previousPath: 'old/name.ts' },
      { path: 'other.ts', status: 'modified' },
    ]);
  });

  it('reports a copy target as an added file with its source as previousPath', () => {
    expect(parseNameStatusZ('C75\0src/base.ts\0src/copy.ts\0')).toEqual([
      { path: 'src/copy.ts', status: 'added', previousPath: 'src/base.ts' },
    ]);
  });

  it('handles paths with spaces and non-ASCII without quoting', () => {
    expect(parseNameStatusZ('M\0dir with space/naïve file.ts\0')).toEqual([
      { path: 'dir with space/naïve file.ts', status: 'modified' },
    ]);
  });

  it('drops a truncated trailing entry instead of guessing (output-cap cut)', () => {
    // status letter present but its path cut mid-way (no terminating NUL):
    expect(parseNameStatusZ('M\0full.ts\0A\0par')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    // status letter present but its path entirely cut off:
    expect(parseNameStatusZ('M\0full.ts\0A\0')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    // rename cut before its target field:
    expect(parseNameStatusZ('M\0full.ts\0R100\0old.ts\0')).toEqual([{ path: 'full.ts', status: 'modified' }]);
    expect(parseNameStatusZ('M\0full.ts\0R100\0old.ts\0new')).toEqual([{ path: 'full.ts', status: 'modified' }]);
  });
});
