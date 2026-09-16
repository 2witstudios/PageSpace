import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  extractRequirementIds,
  findResultFiles,
  formatTable,
  hitsFromPassedTests,
  idsNamedBy,
  isPlaywrightJsonReport,
  isVitestJsonReport,
  loadPassedTests,
  nameCarriesId,
  parseAllowlist,
  parseArgs,
  parsePlaywrightJsonReport,
  parseVitestJsonReport,
  reportPasses,
  run,
  stripLineNumberPrefixes,
} from '../check-spec-coverage';

const SPEC = `
# Spec
### MON — Money model
- MON-1 One price.
- MON-2 One credit definition; see MON-10 too.
### X — Cross-cutting
- X-6 Negative tests: a non-member cannot see an Open drive of another org.
## Decisions
- O-6 is not a requirement id.
`;

describe('coverage gate: requirement extraction', () => {
  it('extracts every requirement ID once, in prefix then numeric order', () => {
    expect(extractRequirementIds(SPEC)).toEqual(['MON-1', 'MON-2', 'MON-10', 'X-6']);
  });

  it('strips the pagespace CLI line-number prefix so IDs are found in a page read', () => {
    const paged = '   1 | # Spec\n  12 | - WAL-3 A wallet.\n';
    expect(stripLineNumberPrefixes(paged)).toBe('# Spec\n- WAL-3 A wallet.\n');
    expect(extractRequirementIds(stripLineNumberPrefixes(paged))).toEqual(['WAL-3']);
  });
});

describe('coverage gate: ID matching', () => {
  it('matches an ID only as a whole token (not a longer number, not a longer prefix)', () => {
    expect(nameCarriesId('MON-20 something', 'MON-2')).toBe(false);
    expect(nameCarriesId('XMON-2 something', 'MON-2')).toBe(false);
    expect(nameCarriesId('MON-2: something', 'MON-2')).toBe(true);
    expect(nameCarriesId('guards MON-2', 'MON-2')).toBe(true);
    expect([...idsNamedBy(['MON-20 x', 'X-6 y'], ['MON-2', 'MON-20', 'X-6'])]).toEqual(['MON-20', 'X-6']);
  });

  it('parses the allowlist ignoring comments and blank lines', () => {
    expect(parseAllowlist('# header\n\nMON-1  # trailing\n  X-6\n')).toEqual(['MON-1', 'X-6']);
  });
});

// Every JSON blob below has the exact shape captured from a REAL `vitest run --reporter=json`
// / `playwright test --reporter=json` invocation, not a hand-guessed schema — see PR #2651 for
// the captured sample this was checked against (a suite with a `.skip`, a test inside
// `if (false)` that never registers at all, and a real passing test: the skip reported
// `status: "skipped"`, the if(false) test did not appear in `assertionResults` at all, and only
// the real test reported `status: "passed"`).
describe('coverage gate: parsing Vitest\'s JSON reporter', () => {
  const vitestReport = {
    numTotalTestSuites: 1,
    success: true,
    testResults: [
      {
        name: '/repo/packages/lib/src/__tests__/money.test.ts',
        status: 'passed',
        assertionResults: [
          { ancestorTitles: ['money model'], title: 'MON-2 one definition of a credit', fullName: 'money model MON-2 one definition of a credit', status: 'passed' },
          { ancestorTitles: ['money model'], title: 'MON-1 skipped price check', fullName: 'money model MON-1 skipped price check', status: 'skipped' },
          { ancestorTitles: ['money model'], title: 'MON-3 a todo', fullName: 'money model MON-3 a todo', status: 'todo' },
          { ancestorTitles: ['money model'], title: 'MON-4 a failure', fullName: 'money model MON-4 a failure', status: 'failed' },
        ],
      },
    ],
  };

  it('recognizes the Vitest JSON reporter shape (testResults array) and not Playwright\'s (suites array)', () => {
    expect(isVitestJsonReport(vitestReport)).toBe(true);
    expect(isPlaywrightJsonReport(vitestReport)).toBe(false);
  });

  it('collects only assertionResults with status "passed" — skipped, todo, and failed never count', () => {
    expect(parseVitestJsonReport(vitestReport)).toEqual([
      { file: '/repo/packages/lib/src/__tests__/money.test.ts', fullName: 'money model MON-2 one definition of a credit' },
    ]);
  });

  it('falls back to ancestorTitles + title when fullName is absent', () => {
    const report = {
      testResults: [
        {
          name: '/repo/a.test.ts',
          assertionResults: [{ ancestorTitles: ['WAL-1 suite'], title: 'a passing case', status: 'passed' }],
        },
      ],
    };
    expect(parseVitestJsonReport(report)).toEqual([{ file: '/repo/a.test.ts', fullName: 'WAL-1 suite a passing case' }]);
  });

  it('returns nothing for a value that is not a Vitest report at all', () => {
    expect(parseVitestJsonReport({ suites: [] })).toEqual([]);
    expect(parseVitestJsonReport(null)).toEqual([]);
    expect(parseVitestJsonReport('not json shaped like a report')).toEqual([]);
  });
});

describe('coverage gate: parsing Playwright\'s JSON reporter', () => {
  const playwrightReport = {
    config: {},
    suites: [
      {
        title: '',
        file: '',
        suites: [
          {
            title: 'SEAT-1 org picker',
            file: 'tests/org-picker.spec.ts',
            specs: [
              { title: 'shows the org name', file: 'tests/org-picker.spec.ts', tests: [{ results: [{ status: 'failed' }, { status: 'passed' }] }] },
              { title: 'a skipped case', file: 'tests/org-picker.spec.ts', tests: [{ results: [{ status: 'skipped' }] }] },
            ],
            suites: [
              {
                title: 'nested group',
                specs: [{ title: 'SEC-1 a nested passing spec', file: 'tests/org-picker.spec.ts', tests: [{ results: [{ status: 'passed' }] }] }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('recognizes the Playwright JSON reporter shape (suites array, no testResults array)', () => {
    expect(isPlaywrightJsonReport(playwrightReport)).toBe(true);
    expect(isVitestJsonReport(playwrightReport)).toBe(false);
  });

  it('builds the full name from every ancestor suite title plus the spec title, only for specs with a passing result (including a retry that eventually passed)', () => {
    expect(parsePlaywrightJsonReport(playwrightReport)).toEqual([
      { file: 'tests/org-picker.spec.ts', fullName: 'SEAT-1 org picker shows the org name' },
      { file: 'tests/org-picker.spec.ts', fullName: 'SEAT-1 org picker nested group SEC-1 a nested passing spec' },
    ]);
  });

  it('returns nothing for a value that is not a Playwright report at all', () => {
    expect(parsePlaywrightJsonReport({ testResults: [] })).toEqual([]);
    expect(parsePlaywrightJsonReport(undefined)).toEqual([]);
  });
});

describe('coverage gate: hitsFromPassedTests', () => {
  it('maps each file to the set of IDs a PASSING test in it names, merging multiple passing tests in the same file', () => {
    const hits = hitsFromPassedTests(
      [
        { file: 'a.test.ts', fullName: 'MON-2 one thing' },
        { file: 'a.test.ts', fullName: 'X-6 another thing' },
        { file: 'b.test.ts', fullName: 'unrelated name' },
      ],
      ['MON-2', 'X-6'],
    );
    expect([...(hits.get('a.test.ts') ?? [])].sort()).toEqual(['MON-2', 'X-6']);
    expect(hits.has('b.test.ts')).toBe(false);
  });
});

describe('coverage gate: report and allowlist ratchet', () => {
  const ids = ['MON-1', 'MON-2', 'X-6'];
  const hits = new Map<string, Set<string>>([
    ['packages/lib/src/a.test.ts', new Set(['MON-2'])],
    ['apps/web/src/b.test.tsx', new Set(['MON-2', 'X-6'])],
    ['apps/web/src/c.test.ts', new Set()],
  ]);

  it('fails on an ID with no passing test that is not allowlisted, and lists the files per ID', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: [] });
    expect(report.missing).toEqual(['MON-1']);
    expect(report.rows.find((r) => r.id === 'MON-2')?.files).toEqual([
      'apps/web/src/b.test.tsx',
      'packages/lib/src/a.test.ts',
    ]);
    expect(reportPasses(report)).toBe(false);
  });

  it('passes when every uncovered ID is allowlisted', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1'] });
    expect(report.missing).toEqual([]);
    expect(report.allowlistedMissing).toEqual(['MON-1']);
    expect(reportPasses(report)).toBe(true);
  });

  it('fails when an allowlisted ID is now covered by a passing test (the allowlist must shrink)', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-2'] });
    expect(report.staleAllowlist).toEqual(['MON-2']);
    expect(reportPasses(report)).toBe(false);
  });

  it('fails on an allowlist token that is not a Spec ID', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1', 'MON-99'] });
    expect(report.unknownAllowlist).toEqual(['MON-99']);
    expect(reportPasses(report)).toBe(false);
  });

  it('--ids narrows the report to the requested IDs', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: [], onlyIds: ['X-6'] });
    expect(report.rows.map((r) => r.id)).toEqual(['X-6']);
    expect(report.missing).toEqual([]);
  });

  it('renders one table row per ID with a status column', () => {
    const table = formatTable(buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1'] }));
    expect(table).toContain('MON-1  allowlisted  -');
    expect(table).toContain('MON-2  covered      apps/web/src/b.test.tsx, packages/lib/src/a.test.ts');
  });

  it('parses --ids, --allowlist, --snapshot, --offline, --json and rejects unknown flags', () => {
    expect(parseArgs(['--ids', 'MON-2, X-6', '--offline', '--json', '--allowlist', 'a.txt', '--snapshot', 's.md'])).toEqual({
      ids: ['MON-2', 'X-6'],
      allowlist: 'a.txt',
      snapshot: 's.md',
      offline: true,
      json: true,
    });
    expect(parseArgs(['--ids=X-6']).ids).toEqual(['X-6']);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('coverage gate: end to end over a temp repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/lib/test-results'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/e2e/test-results'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/specs/organizations-wallets.md'), SPEC);
    fs.writeFileSync(path.join(root, 'scripts/spec-coverage-allowlist.txt'), 'MON-1\nMON-10\n');

    // A REAL vitest JSON reporter shape: a passing test (MON-2), and a SKIPPED test that names
    // an ID (MON-1) — a static reader of the source would have to be told the modifier means
    // "never runs"; a results reader gets that for free because there is no `passed` result.
    fs.writeFileSync(
      path.join(root, 'packages/lib/test-results/vitest-results.json'),
      JSON.stringify({
        testResults: [
          {
            name: path.join(root, 'packages/lib/src/__tests__/money.test.ts'),
            assertionResults: [
              { ancestorTitles: [], title: 'MON-2 one definition of a credit', fullName: 'MON-2 one definition of a credit', status: 'passed' },
              { ancestorTitles: [], title: 'MON-1 gated behind an if(false), or skipped — either way, never passed', fullName: 'MON-1 gated behind an if(false), or skipped — either way, never passed', status: 'skipped' },
            ],
          },
        ],
      }),
    );

    // A REAL Playwright JSON reporter shape: X-6 passes in e2e.
    fs.writeFileSync(
      path.join(root, 'apps/e2e/test-results/playwright-results.json'),
      JSON.stringify({
        config: {},
        suites: [
          {
            title: 'X-6 negatives',
            file: 'tests/negatives.spec.ts',
            specs: [{ title: 'X-6 a guest sees one drive', file: 'tests/negatives.spec.ts', tests: [{ results: [{ status: 'passed' }] }] }],
          },
        ],
      }),
    );
    return root;
  }

  it('findResultFiles finds test-results/*.json under packages/, apps/, scripts/, and infrastructure/ only', () => {
    const root = makeRepo();
    expect(findResultFiles(root)).toEqual([
      'apps/e2e/test-results/playwright-results.json',
      'packages/lib/test-results/vitest-results.json',
    ]);
  });

  it('reads the Playwright file where CI download-artifact extracts it: the repo root, since a single-file artifact is rooted at the file\'s own directory', () => {
    const root = makeRepo();
    fs.renameSync(path.join(root, 'apps/e2e/test-results/playwright-results.json'), path.join(root, 'playwright-results.json'));
    fs.rmdirSync(path.join(root, 'apps/e2e/test-results'));
    expect(findResultFiles(root)).toEqual(['packages/lib/test-results/vitest-results.json', 'playwright-results.json']);
    const loaded = loadPassedTests(root);
    expect(loaded.sawPlaywright).toBe(true);
    const warnings: string[] = [];
    run(root, parseArgs(['--offline']), (line) => warnings.push(line));
    expect(warnings.some((line) => line.includes('no Playwright JSON results found'))).toBe(false);
  });

  it('loadPassedTests parses both reporter shapes and reports which sources were seen', () => {
    const root = makeRepo();
    const loaded = loadPassedTests(root);
    expect(loaded.sawVitest).toBe(true);
    expect(loaded.sawPlaywright).toBe(true);
    expect(loaded.tests.map((t) => t.fullName).sort()).toEqual(['MON-2 one definition of a credit', 'X-6 negatives X-6 a guest sees one drive']);
  });

  it('exits 0 when every ID is covered by a PASSING result or allowlisted, and 1 once the covering results are deleted', () => {
    const root = makeRepo();
    const lines: string[] = [];
    const opts = parseArgs(['--offline']);
    expect(run(root, opts, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe('spec-coverage: OK');
    expect(lines.join('\n')).not.toContain('WARNING');

    fs.rmSync(path.join(root, 'apps/e2e/test-results/playwright-results.json'));
    const failing: string[] = [];
    expect(run(root, opts, (l) => failing.push(l))).toBe(1);
    expect(failing.join('\n')).toContain('WARNING: no Playwright JSON results found');
    expect(failing.join('\n')).toContain('FAIL: no passing test names these IDs: X-6');
  });

  it('--json emits the report with the spec origin and source flags', () => {
    const root = makeRepo();
    const lines: string[] = [];
    expect(run(root, parseArgs(['--offline', '--json']), (l) => lines.push(l))).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { origin: string; ok: boolean; sawVitest: boolean; sawPlaywright: boolean; missing: string[] };
    expect(parsed.origin).toBe('snapshot');
    expect(parsed.ok).toBe(true);
    expect(parsed.sawVitest).toBe(true);
    expect(parsed.sawPlaywright).toBe(true);
    expect(parsed.missing).toEqual([]);
  });

  it('fails loudly when the snapshot is missing and the page is not read', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, 'docs/specs/organizations-wallets.md'));
    expect(() => run(root, parseArgs(['--offline']), () => {})).toThrow(/Spec snapshot not found/);
  });

  it('fails loudly when there are no test-results files at all, rather than silently reporting OK against zero data', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, 'packages/lib/test-results/vitest-results.json'));
    fs.rmSync(path.join(root, 'apps/e2e/test-results/playwright-results.json'));
    expect(() => run(root, parseArgs(['--offline']), () => {})).toThrow(/No test-results\/\*\.json files found/);
  });

  it('fails loudly on a test-results file that is neither reporter shape, rather than silently ignoring it', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'packages/lib/test-results/mystery.json'), JSON.stringify({ nope: true }));
    expect(() => run(root, parseArgs(['--offline']), () => {})).toThrow(/is neither a Vitest nor a Playwright JSON reporter file/);
  });
});
