import { describe, it, expect } from 'vitest';
import {
  SUPPRESSION_RULE,
  countByFileAndRule,
  countSuppressions,
  diffAgainstBaseline,
  formatReport,
  grandTotal,
  ruleTotals,
  serializeBaseline,
} from '../quality/lib.mjs';

const identity = (p: string) => p;

describe('countSuppressions', () => {
  it('counts line, next-line, and block directives', () => {
    const src = [
      '// eslint-disable-next-line no-var',
      'var a = 1; // eslint-disable-line',
      '/* eslint-disable no-param-reassign */',
      'const clean = 2;',
    ].join('\n');
    expect(countSuppressions(src)).toBe(3);
  });

  it('returns 0 for clean source', () => {
    expect(countSuppressions('const a = 1;\n')).toBe(0);
  });
});

describe('countByFileAndRule', () => {
  it('folds messages and suppressions into per-file per-rule counts, omitting clean files', () => {
    const results = [
      {
        filePath: 'a.ts',
        messages: [
          { ruleId: 'no-var' },
          { ruleId: 'no-var' },
          { ruleId: 'complexity' },
        ],
      },
      { filePath: 'clean.ts', messages: [] },
    ];
    const files = countByFileAndRule(results, { 'b.ts': 2 }, identity);
    expect(files).toEqual({
      'a.ts': { 'no-var': 2, complexity: 1 },
      'b.ts': { [SUPPRESSION_RULE]: 2 },
    });
  });

  it('tracks parse failures (null ruleId) under a stable pseudo-rule', () => {
    const results = [{ filePath: 'broken.ts', messages: [{ ruleId: null }] }];
    const files = countByFileAndRule(results, {}, identity);
    expect(files['broken.ts']).toEqual({ 'quality/parse-error': 1 });
  });
});

describe('diffAgainstBaseline', () => {
  const baseline = {
    'a.ts': { 'no-var': 2, complexity: 1 },
    'gone.ts': { 'no-var': 1 },
  };

  it('passes when counts are unchanged', () => {
    const { regressions, improvements } = diffAgainstBaseline(baseline, {
      'a.ts': { 'no-var': 2, complexity: 1 },
      'gone.ts': { 'no-var': 1 },
    });
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([]);
  });

  it('flags any per-cell increase as a regression, including new files and new rules', () => {
    const { regressions } = diffAgainstBaseline(baseline, {
      'a.ts': { 'no-var': 3, complexity: 1 },
      'gone.ts': { 'no-var': 1 },
      'new.ts': { eqeqeq: 1 },
    });
    expect(regressions).toEqual([
      { file: 'a.ts', rule: 'no-var', baseline: 2, current: 3 },
      { file: 'new.ts', rule: 'eqeqeq', baseline: 0, current: 1 },
    ]);
  });

  it('does not let a fix in one file offset a new violation in another', () => {
    const { regressions, improvements } = diffAgainstBaseline(baseline, {
      'a.ts': { complexity: 1 }, // both no-var fixed
      'gone.ts': { 'no-var': 2 }, // one added
    });
    expect(improvements).toEqual([
      { file: 'a.ts', rule: 'no-var', baseline: 2, current: 0 },
    ]);
    expect(regressions).toEqual([
      { file: 'gone.ts', rule: 'no-var', baseline: 1, current: 2 },
    ]);
  });

  it('reports deleted files as improvements', () => {
    const { regressions, improvements } = diffAgainstBaseline(baseline, {
      'a.ts': { 'no-var': 2, complexity: 1 },
    });
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { file: 'gone.ts', rule: 'no-var', baseline: 1, current: 0 },
    ]);
  });
});

describe('ruleTotals / grandTotal', () => {
  it('sums per-rule and overall', () => {
    const files = {
      'a.ts': { 'no-var': 2, complexity: 1 },
      'b.ts': { 'no-var': 1 },
    };
    expect(ruleTotals(files)).toEqual({ 'no-var': 3, complexity: 1 });
    expect(grandTotal(files)).toBe(4);
  });
});

describe('serializeBaseline', () => {
  it('is deterministic regardless of insertion order', () => {
    const a = serializeBaseline({
      'b.ts': { 'no-var': 1 },
      'a.ts': { complexity: 1, 'no-var': 2 },
    });
    const b = serializeBaseline({
      'a.ts': { 'no-var': 2, complexity: 1 },
      'b.ts': { 'no-var': 1 },
    });
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(Object.keys(parsed.files)).toEqual(['a.ts', 'b.ts']);
    expect(parsed.totals).toEqual({ complexity: 1, 'no-var': 3 });
  });
});

describe('formatReport', () => {
  it('names regressions and instructs on the escape hatch', () => {
    const baselineFiles = { 'a.ts': { 'no-var': 1 } };
    const currentFiles = { 'a.ts': { 'no-var': 2 } };
    const { regressions, improvements } = diffAgainstBaseline(baselineFiles, currentFiles);
    const report = formatReport({ regressions, improvements, baselineFiles, currentFiles }).join('\n');
    expect(report).toContain('FAIL: 1 regression(s)');
    expect(report).toContain('a.ts');
    expect(report).toContain('no-var: 1 -> 2');
    expect(report).toContain('quality:update');
  });

  it('suggests locking in improvements when nothing regressed', () => {
    const baselineFiles = { 'a.ts': { 'no-var': 2 } };
    const currentFiles = { 'a.ts': { 'no-var': 1 } };
    const { regressions, improvements } = diffAgainstBaseline(baselineFiles, currentFiles);
    const report = formatReport({ regressions, improvements, baselineFiles, currentFiles }).join('\n');
    expect(report).not.toContain('FAIL');
    expect(report).toContain('lock in the gains');
  });
});
