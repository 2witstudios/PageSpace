import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  extractRequirementIds,
  findResultFiles,
  formatTable,
  failsModifierFiles,
  hitsFromTestOutcomes,
  idsNamedBy,
  isPlaywrightJsonReport,
  isVitestJsonReport,
  loadTestOutcomes,
  malformedPartialMarkers,
  securityOnlyWarnings,
  nameCarriesId,
  nameCarriesPartialId,
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
// Titles in this file must name no real Spec ID and carry no literal partial marker: the gate reads
// this file's own CI results too (see the last describe block, which enforces the first rule).
describe('coverage gate: the partial marker', () => {
  it('a title naming an ID only with the partial marker does not claim it, but is recognized as a partial hit', () => {
    expect(nameCarriesId('MON-3 (partial) sums base and extra-seat lines', 'MON-3')).toBe(false);
    expect(nameCarriesPartialId('MON-3 (partial) sums base and extra-seat lines', 'MON-3')).toBe(true);
    expect(nameCarriesPartialId('MON-3 sums base and extra-seat lines', 'MON-3')).toBe(false);
  });

  it('the marker binds only to the ID right before it: in "<A>/<B> + marker" the first ID is still claimed', () => {
    expect(nameCarriesId('MON-2/MON-3 (partial) the org seam', 'MON-2')).toBe(true);
    expect(nameCarriesPartialId('MON-2/MON-3 (partial) the org seam', 'MON-2')).toBe(false);
    expect(nameCarriesId('MON-2/MON-3 (partial) the org seam', 'MON-3')).toBe(false);
  });

  it('a second, unmarked mention of the same ID is still a claim', () => {
    expect(nameCarriesId('MON-3 (partial) seam; MON-3 the refill itself', 'MON-3')).toBe(true);
  });

  it('only the exact marker counts: another parenthetical, or no space, is still a claim', () => {
    expect(nameCarriesId('SEAT-2 (independent review) accepts the Pro price', 'SEAT-2')).toBe(true);
    expect(nameCarriesId('SEAT-2(partial) no space', 'SEAT-2')).toBe(true);
    expect(nameCarriesPartialId('SEAT-2(partial) no space', 'SEAT-2')).toBe(false);
  });
});

describe('coverage gate: malformed partial markers fail loudly', () => {
  const t = (title: string, ancestors: string[] = []) => ({ runner: 'vitest' as const, file: 'a.test.ts', title, ancestors, passed: true });

  it('flags every near-miss marker shape (fake IDs), naming the file and the title', () => {
    const nearMisses = [
      'MON-90 (Partial) capitalized',
      'MON-91  (partial) two spaces',
      'MON-92\u00a0(partial) non-breaking space',
      'MON-93 (partial ) inner space',
      'MON-94 ( partial) inner space',
      'MON-95 (PARTIAL) upper case',
      'MON-96(partial) no space',
      '(partial) no ID before it',
      'mentions MON-97 then (partial) away from it',
    ];
    for (const title of nearMisses) {
      expect(malformedPartialMarkers([t(title)]), title).toEqual([{ file: 'a.test.ts', name: title }]);
    }
    expect(malformedPartialMarkers([t('ordinary title', ['SEAT-91 (Partial) suite'])])).toEqual([{ file: 'a.test.ts', name: 'SEAT-91 (Partial) suite' }]);
  });

  it('accepts the exact marker after any ID family, and titles with no marker at all', () => {
    expect(malformedPartialMarkers([t('MON-90 (partial) seam'), t('x', ['SEAT-91 (partial) suite']), t('MON-92/X-93 (partial) both'), t('plain title MON-94')])).toEqual([]);
  });

  it('fails the gate end to end on a malformed marker, even when the ID is otherwise allowlisted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-malformed-'));
    try {
      fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages/lib/test-results'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs/specs/organizations-wallets.md'), '- MON-90 A fake requirement.\n');
      fs.writeFileSync(path.join(root, 'scripts/spec-coverage-allowlist.txt'), 'MON-90\n');
      fs.writeFileSync(
        path.join(root, 'packages/lib/test-results/vitest-results.json'),
        JSON.stringify({ testResults: [{ name: path.join(root, 'packages/lib/src/seam.test.ts'), assertionResults: [{ ancestorTitles: [], title: 'MON-90 (Partial) the seam', fullName: 'MON-90 (Partial) the seam', status: 'skipped' }] }] }),
      );
      const lines: string[] = [];
      expect(run(root, parseArgs(['--offline']), (l) => lines.push(l))).toBe(1);
      expect(lines.join('\n')).toContain('FAIL: malformed partial marker in packages/lib/src/seam.test.ts: "MON-90 (Partial) the seam"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('keeps every assertion with its own title, its describe titles, and passed only for status "passed" — skipped, todo, and failed never pass', () => {
    const file = '/repo/packages/lib/src/__tests__/money.test.ts';
    expect(parseVitestJsonReport(vitestReport)).toEqual([
      { runner: 'vitest', file, title: 'MON-2 one definition of a credit', ancestors: ['money model'], passed: true },
      { runner: 'vitest', file, title: 'MON-1 skipped price check', ancestors: ['money model'], passed: false },
      { runner: 'vitest', file, title: 'MON-3 a todo', ancestors: ['money model'], passed: false },
      { runner: 'vitest', file, title: 'MON-4 a failure', ancestors: ['money model'], passed: false },
    ]);
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

  it('keeps every spec with its ancestor suite titles; passed only when some result passed (a retry that eventually passed counts)', () => {
    const file = 'tests/org-picker.spec.ts';
    expect(parsePlaywrightJsonReport(playwrightReport)).toEqual([
      { runner: 'playwright', file, title: 'shows the org name', ancestors: ['SEAT-1 org picker'], passed: true },
      { runner: 'playwright', file, title: 'a skipped case', ancestors: ['SEAT-1 org picker'], passed: false },
      { runner: 'playwright', file, title: 'SEC-1 a nested passing spec', ancestors: ['SEAT-1 org picker', 'nested group'], passed: true },
    ]);
  });

  it('returns nothing for a value that is not a Playwright report at all', () => {
    expect(parsePlaywrightJsonReport({ testResults: [] })).toEqual([]);
    expect(parsePlaywrightJsonReport(undefined)).toEqual([]);
  });
});

describe('coverage gate: hitsFromTestOutcomes', () => {
  const t = (file: string, title: string, ancestors: string[], passed: boolean) => ({ runner: 'vitest' as const, file, title, ancestors, passed });

  it('maps each file to the set of IDs a PASSING test\'s own title names, merging multiple passing tests in the same file', () => {
    const hits = hitsFromTestOutcomes(
      [t('a.test.ts', 'MON-2 one thing', [], true), t('a.test.ts', 'X-6 another thing', [], true), t('b.test.ts', 'unrelated name', [], true)],
      ['MON-2', 'X-6'],
    );
    expect([...(hits.get('a.test.ts') ?? [])].sort()).toEqual(['MON-2', 'X-6']);
    expect(hits.has('b.test.ts')).toBe(false);
  });

  it('never counts a test whose own title names an ID but did not pass', () => {
    expect(hitsFromTestOutcomes([t('a.test.ts', 'MON-2 skipped', [], false)], ['MON-2']).size).toBe(0);
  });

  it('does not let a passing sibling carry a describe-level ID when another test under that describe was skipped', () => {
    const hits = hitsFromTestOutcomes(
      [t('a.test.ts', 'the real negative check', ['MON-2 suite'], false), t('a.test.ts', 'renders a heading', ['MON-2 suite'], true)],
      ['MON-2'],
    );
    expect(hits.has('a.test.ts')).toBe(false);
  });

  it('counts a describe-level ID when EVERY test under an ID-named describe in that file passed', () => {
    const hits = hitsFromTestOutcomes(
      [t('a.test.ts', 'one', ['MON-2 suite'], true), t('a.test.ts', 'two', ['MON-2 suite', 'nested'], true), t('a.test.ts', 'unrelated skipped', ['other'], false)],
      ['MON-2'],
    );
    expect([...(hits.get('a.test.ts') ?? [])]).toEqual(['MON-2']);
  });

  it('a passing partial-only test is not a hit, but the partial matcher collects it (own title and describe) for traceability', () => {
    const tests = [
      t('a.test.ts', 'MON-3 (partial) sums base and extra-seat lines', [], true),
      t('b.test.tsx', 'renders the Business terms', ['PlanCard (MON-6, SEAT-2 (partial), A-9)'], true),
    ];
    const full = hitsFromTestOutcomes(tests, ['MON-3', 'MON-6', 'SEAT-2']);
    expect(full.has('a.test.ts')).toBe(false);
    expect([...(full.get('b.test.tsx') ?? [])]).toEqual(['MON-6']);
    const partial = hitsFromTestOutcomes(tests, ['MON-3', 'MON-6', 'SEAT-2'], nameCarriesPartialId);
    expect([...(partial.get('a.test.ts') ?? [])]).toEqual(['MON-3']);
    expect([...(partial.get('b.test.tsx') ?? [])]).toEqual(['SEAT-2']);
  });

  it('a passing test that names the ID in its own title still counts even if a describe sibling was skipped', () => {
    const hits = hitsFromTestOutcomes(
      [t('a.test.ts', 'MON-2 the real check', ['MON-2 suite'], true), t('a.test.ts', 'a skipped extra', ['MON-2 suite'], false)],
      ['MON-2'],
    );
    expect([...(hits.get('a.test.ts') ?? [])]).toEqual(['MON-2']);
  });
});

describe('coverage gate: it.fails ban', () => {
  it('flags a Vitest file that contributes an ID and uses .fails (Vitest reports it.fails as passed when its body fails)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-fails-'));
    try {
      fs.writeFileSync(path.join(root, 'a.test.ts'), "it.fails('MON-2 body fails', () => { expect(1).toBe(2); });\n");
      fs.writeFileSync(path.join(root, 'b.test.ts'), "it('MON-2 honest', () => {});\n");
      fs.writeFileSync(path.join(root, 'c.test.ts'), "it.fails('no id here', () => {});\n");
      const hits = new Map([['a.test.ts', new Set(['MON-2'])], ['b.test.ts', new Set(['MON-2'])]]);
      expect(failsModifierFiles(root, hits)).toEqual(['a.test.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a contributing Vitest file cannot be read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-fails-'));
    try {
      expect(() => failsModifierFiles(root, new Map([['gone.test.ts', new Set(['MON-2'])]]))).toThrow(/Cannot read gone\.test\.ts/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('a partial-only ID is NOT covered: allowlisted it stays allowlisted-missing (not stale), and it still lists the partial files', () => {
    const partialHitsByFile = new Map([['packages/lib/src/seam.test.ts', new Set(['MON-1'])]]);
    const report = buildReport({ ids, hitsByFile: hits, partialHitsByFile, allowlist: ['MON-1'] });
    expect(report.staleAllowlist).toEqual([]);
    expect(report.allowlistedMissing).toEqual(['MON-1']);
    expect(report.rows.find((r) => r.id === 'MON-1')?.partialFiles).toEqual(['packages/lib/src/seam.test.ts']);
    expect(reportPasses(report)).toBe(true);
    expect(formatTable(report)).toContain('MON-1  allowlisted  partial: packages/lib/src/seam.test.ts');
  });

  it('a partial-only ID that is not allowlisted is MISSING', () => {
    const partialHitsByFile = new Map([['packages/lib/src/seam.test.ts', new Set(['MON-1'])]]);
    const report = buildReport({ ids, hitsByFile: hits, partialHitsByFile, allowlist: [] });
    expect(report.missing).toEqual(['MON-1']);
    expect(reportPasses(report)).toBe(false);
  });

  it('partial + a full passing hit is covered (and an allowlist entry for it is stale)', () => {
    const partialHitsByFile = new Map([['packages/lib/src/seam.test.ts', new Set(['MON-2'])]]);
    const covered = buildReport({ ids, hitsByFile: hits, partialHitsByFile, allowlist: ['MON-1'] });
    expect(covered.rows.find((r) => r.id === 'MON-2')).toMatchObject({ files: ['apps/web/src/b.test.tsx', 'packages/lib/src/a.test.ts'], partialFiles: ['packages/lib/src/seam.test.ts'] });
    expect(reportPasses(covered)).toBe(true);
    const stale = buildReport({ ids, hitsByFile: hits, partialHitsByFile, allowlist: ['MON-1', 'MON-2'] });
    expect(stale.staleAllowlist).toEqual(['MON-2']);
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
    fs.mkdirSync(path.join(root, 'packages/lib/src/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/lib/src/__tests__/money.test.ts'), "it('MON-2 one definition of a credit', () => {});\n");
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
    const loaded = loadTestOutcomes(root);
    expect(loaded.sawPlaywright).toBe(true);
    const warnings: string[] = [];
    run(root, parseArgs(['--offline']), (line) => warnings.push(line));
    expect(warnings.some((line) => line.includes('no Playwright JSON results found'))).toBe(false);
  });

  it('loadTestOutcomes parses both reporter shapes and reports which sources were seen', () => {
    const root = makeRepo();
    const loaded = loadTestOutcomes(root);
    expect(loaded.sawVitest).toBe(true);
    expect(loaded.sawPlaywright).toBe(true);
    expect(loaded.tests.filter((t) => t.passed).map((t) => t.title).sort()).toEqual(['MON-2 one definition of a credit', 'X-6 a guest sees one drive']);
  });

  it('fails the gate when a file that contributes an ID uses .fails', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'packages/lib/src/__tests__/money.test.ts'), "it.fails('MON-2 one definition of a credit', () => {});\n");
    const lines: string[] = [];
    expect(run(root, parseArgs(['--offline']), (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('FAIL: these files contribute Spec IDs but use `.fails`');
    expect(lines.join('\n')).toContain('packages/lib/src/__tests__/money.test.ts');
  });

  it('states that only ci.yml runners count, and WARNS when an unmet ID is named in a file only security.yml runs', () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/lib/src/permissions/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/lib/src/permissions/__tests__/boundary.test.ts'), "it('MON-10 a boundary', () => {});\n");
    fs.writeFileSync(
      path.join(root, '.github/workflows/security.yml'),
      [
        'jobs:',
        '  s:',
        '    steps:',
        '      - run: |',
        "          bun run --filter '@pagespace/lib' test:db -- \\",
        '            src/permissions/__tests__/boundary.test.ts \\',
        '            src/__tests__/money.test.ts',
        "      - run: bun run --filter 'web' test -- src/app/api/auth/__tests__/",
        '',
      ].join('\n'),
    );
    const lines: string[] = [];
    expect(run(root, parseArgs(['--offline']), (l) => lines.push(l))).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('only test runs in ci.yml reach this gate');
    expect(out).toContain('WARNING: MON-10 is named in packages/lib/src/permissions/__tests__/boundary.test.ts, which only security.yml runs');
    expect(securityOnlyWarnings(root, loadTestOutcomes(root).tests, ['MON-2'])).toEqual([]); // money.test.ts names MON-2 and is in security.yml, but ci.yml ran it
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

  it('end to end: a passing partial-marked result does not cover an allowlisted ID, is not STALE-ALLOW, and is listed in the table', () => {
    const root = makeRepo();
    const resultsPath = path.join(root, 'packages/lib/test-results/vitest-results.json');
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as { testResults: { assertionResults: unknown[] }[] };
    results.testResults[0].assertionResults.push({ ancestorTitles: [], title: 'MON-1 (partial) the price seam only', fullName: 'MON-1 (partial) the price seam only', status: 'passed' });
    fs.writeFileSync(resultsPath, JSON.stringify(results));
    const lines: string[] = [];
    expect(run(root, parseArgs(['--offline']), (l) => lines.push(l))).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('MON-1   allowlisted  partial: packages/lib/src/__tests__/money.test.ts');
    expect(out).not.toContain('STALE-ALLOW');
    expect(lines.at(-1)).toBe('spec-coverage: OK');
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

describe('coverage gate: this self-test file claims nothing', () => {
  it('no it/test/describe title in this file names a real Spec ID or carries a partial marker (the gate reads these results too)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const specIds = new Set(extractRequirementIds(fs.readFileSync(path.join(repoRoot, 'docs/specs/organizations-wallets.md'), 'utf8')));
    expect(specIds.size).toBeGreaterThan(0);
    const source = fs.readFileSync(__filename, 'utf8');
    const titles = [...source.matchAll(/^\s*(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);
    expect(titles.length).toBeGreaterThan(40);
    const offenders = titles.filter((title) => extractRequirementIds(title).some((id) => specIds.has(id)) || /\(\s*partial\s*\)/i.test(title));
    expect(offenders).toEqual([]);
  });
});
