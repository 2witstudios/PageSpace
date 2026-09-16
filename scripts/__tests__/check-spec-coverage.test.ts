import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  extractRequirementIds,
  extractTestNames,
  findTestFiles,
  formatTable,
  idsNamedBy,
  nameCarriesId,
  parseAllowlist,
  parseArgs,
  reportPasses,
  run,
  scanTestFiles,
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

describe('X-6 spec ID-coverage gate: requirement extraction', () => {
  it('X-6 extracts every requirement ID once, in prefix then numeric order', () => {
    expect(extractRequirementIds(SPEC)).toEqual(['MON-1', 'MON-2', 'MON-10', 'X-6']);
  });

  it('X-6 strips the pagespace CLI line-number prefix so IDs are found in a page read', () => {
    const paged = '   1 | # Spec\n  12 | - WAL-3 A wallet.\n';
    expect(stripLineNumberPrefixes(paged)).toBe('# Spec\n- WAL-3 A wallet.\n');
    expect(extractRequirementIds(stripLineNumberPrefixes(paged))).toEqual(['WAL-3']);
  });
});

describe('X-6 spec ID-coverage gate: test-name extraction', () => {
  it('X-6 collects it/test/describe names and riteway given/should strings', () => {
    const src = `
      describe('MON-2 money model', () => {
        it("MON-2 renders an integer count", () => {});
        test(\`WAL-1 template name\`, () => {});
        assert({ given: 'X-6 a non-member', should: 'resolve no drive', actual: 1, expected: 1 });
      });
    `;
    expect(extractTestNames(src)).toEqual([
      'MON-2 money model',
      'MON-2 renders an integer count',
      'WAL-1 template name',
      'X-6 a non-member',
      'resolve no drive',
    ]);
  });

  it('X-6 does not count skipped, todo, fixme, or commented-out declarations', () => {
    const src = `
      it.skip('MON-1 skipped', () => {});
      it.todo('MON-3 todo');
      test.fixme('MON-4 fixme', () => {});
      // it('MON-5 commented out', () => {});
      /* describe('MON-6 block comment', () => {}); */
      it('MON-7 live', () => {});
    `;
    expect(extractTestNames(src)).toEqual(['MON-7 live']);
  });

  it('X-6 rejects an it() nested inside describe.runIf(false)(...) — runIf is conditional skip too, same as skipIf', () => {
    const src = `
      describe.runIf(false)('MON-8 runIf-gated suite', () => {
        it('MON-8 never runs when the flag is false', () => {});
      });
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 finds the suite callback (not an object literal in the skip condition) via the argument list, not brace-scanning', () => {
    const src = `
      describe.skipIf(check({ org: true }))('WAL-9 suite gated on an object-literal condition', () => {
        it('WAL-9 nested test, must not falsely count as live', () => {});
      });
      it('WAL-9 sibling declared after, must still count', () => {});
    `;
    expect(extractTestNames(src)).toEqual(['WAL-9 sibling declared after, must still count']);
  });

  it('X-6 still counts it.only, test.describe, test.step, and skipIf(false) declarations', () => {
    const src = `
      it.only('SEC-1 only', () => {});
      test.describe('UI-2 playwright group', () => {});
      test.step('UI-3 a step', async () => {});
      it.skipIf(!tableExists)('POL-1 conditional', () => {});
    `;
    expect(extractTestNames(src)).toEqual(['SEC-1 only', 'UI-2 playwright group', 'UI-3 a step', 'POL-1 conditional']);
  });

  it('X-6 rejects an it() nested inside describe.skip(...) even though the it() itself carries no skip modifier', () => {
    const src = `
      describe.skip('MON-8 disabled suite', () => {
        it('MON-8 never runs', () => {});
      });
      it('MON-9 sibling still runs', () => {});
    `;
    expect(extractTestNames(src)).toEqual(['MON-9 sibling still runs']);
  });

  it('X-6 rejects an it() nested inside describe.skipIf(...)(...) — the wrapping suite may never execute', () => {
    const src = `
      describe.skipIf(condition)('MON-8 conditionally disabled suite', () => {
        it('MON-8 might never run', () => {});
      });
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 rejects nested it() two levels inside describe.skip(...) (nested describes)', () => {
    const src = `
      describe.skip('MON-8 outer', () => {
        describe('MON-8 inner group', () => {
          it('MON-8 deeply nested, never runs', () => {});
        });
      });
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 rejects an ID mentioned only via a RegExp.test() method call, not a test declaration', () => {
    const src = `
      const pattern = /MON-2/;
      if (pattern.test('MON-2 direct')) { doSomething(); }
      someRegex.test('MON-2 also not a declaration');
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 rejects given/should fields on a plain object that is not passed to assert()', () => {
    const src = `
      const fixture = { given: 'WAL-1 a wallet', should: 'not count as a test' };
      logFixture(fixture);
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 still counts given/should fields when they ARE the argument to a riteway assert() call', () => {
    const src = `
      assert({ given: 'WAL-1 a wallet', should: 'charge nothing', actual: 1, expected: 1 });
    `;
    expect(extractTestNames(src)).toEqual(['WAL-1 a wallet', 'charge nothing']);
  });

  it('X-6 does not let describe.skip(name, namedCallback) — no inline block — swallow later, unrelated code as a skip region', () => {
    const src = `
      describe.skip('MON-8 uses a named callback, no inline block', suiteBody);
      it('MON-10 a normal running test declared later in the file', () => {
        it('MON-11 nested inside MON-10s own callback, also runs normally', () => {});
      });
    `;
    expect(extractTestNames(src)).toEqual([
      'MON-10 a normal running test declared later in the file',
      'MON-11 nested inside MON-10s own callback, also runs normally',
    ]);
  });

  it('X-6 rejects an assert() call nested inside describe.skip(...)', () => {
    const src = `
      describe.skip('WAL-1 disabled suite', () => {
        assert({ given: 'WAL-1 a wallet', should: 'never run', actual: 1, expected: 1 });
      });
    `;
    expect(extractTestNames(src)).toEqual([]);
  });

  it('X-6 matches an ID only as a whole token (MON-2 is not MON-20 and not XMON-2)', () => {
    expect(nameCarriesId('MON-20 something', 'MON-2')).toBe(false);
    expect(nameCarriesId('XMON-2 something', 'MON-2')).toBe(false);
    expect(nameCarriesId('MON-2: something', 'MON-2')).toBe(true);
    expect(nameCarriesId('guards MON-2', 'MON-2')).toBe(true);
    expect([...idsNamedBy(['MON-20 x', 'X-6 y'], ['MON-2', 'MON-20', 'X-6'])]).toEqual(['MON-20', 'X-6']);
  });
});

describe('X-6 spec ID-coverage gate: report and allowlist ratchet', () => {
  const ids = ['MON-1', 'MON-2', 'X-6'];
  const hits = new Map<string, Set<string>>([
    ['packages/lib/src/a.test.ts', new Set(['MON-2'])],
    ['apps/web/src/b.test.tsx', new Set(['MON-2', 'X-6'])],
    ['apps/web/src/c.test.ts', new Set()],
  ]);

  it('X-6 fails on an ID with no test that is not allowlisted, and lists the files per ID', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: [] });
    expect(report.missing).toEqual(['MON-1']);
    expect(report.rows.find((r) => r.id === 'MON-2')?.files).toEqual([
      'apps/web/src/b.test.tsx',
      'packages/lib/src/a.test.ts',
    ]);
    expect(reportPasses(report)).toBe(false);
  });

  it('X-6 passes when every uncovered ID is allowlisted', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1'] });
    expect(report.missing).toEqual([]);
    expect(report.allowlistedMissing).toEqual(['MON-1']);
    expect(reportPasses(report)).toBe(true);
  });

  it('X-6 fails when an allowlisted ID is now covered (the allowlist must shrink)', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-2'] });
    expect(report.staleAllowlist).toEqual(['MON-2']);
    expect(reportPasses(report)).toBe(false);
  });

  it('X-6 fails on an allowlist token that is not a Spec ID', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1', 'MON-99'] });
    expect(report.unknownAllowlist).toEqual(['MON-99']);
    expect(reportPasses(report)).toBe(false);
  });

  it('X-6 --ids narrows the report to the requested IDs', () => {
    const report = buildReport({ ids, hitsByFile: hits, allowlist: [], onlyIds: ['X-6'] });
    expect(report.rows.map((r) => r.id)).toEqual(['X-6']);
    expect(report.missing).toEqual([]);
  });

  it('X-6 parses the allowlist ignoring comments and blank lines', () => {
    expect(parseAllowlist('# header\n\nMON-1  # trailing\n  X-6\n')).toEqual(['MON-1', 'X-6']);
  });

  it('X-6 renders one table row per ID with a status column', () => {
    const table = formatTable(buildReport({ ids, hitsByFile: hits, allowlist: ['MON-1'] }));
    expect(table).toContain('MON-1  allowlisted  -');
    expect(table).toContain('MON-2  covered      apps/web/src/b.test.tsx, packages/lib/src/a.test.ts');
  });

  it('X-6 parses --ids, --allowlist, --snapshot, --offline, --json and rejects unknown flags', () => {
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

describe('X-6 spec ID-coverage gate: end to end over a temp repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/lib/src/__tests__'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/web/src/node_modules/dep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/specs/organizations-wallets.md'), SPEC);
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/__tests__/money.test.ts'),
      "it('MON-2 one definition of a credit', () => {});\n",
    );
    fs.writeFileSync(
      path.join(root, 'apps/web/src/negatives.test.tsx'),
      "describe('X-6 negatives', () => { it('X-6 a guest sees one drive', () => {}); });\n",
    );
    fs.writeFileSync(path.join(root, 'apps/web/src/node_modules/dep/ignored.test.ts'), "it('MON-1 in node_modules', () => {});\n");
    fs.writeFileSync(path.join(root, 'scripts/spec-coverage-allowlist.txt'), 'MON-1\nMON-10\n');
    return root;
  }

  it('X-6 finds test files under packages/ and apps/ but never inside node_modules', () => {
    const root = makeRepo();
    expect(findTestFiles(root)).toEqual(['apps/web/src/negatives.test.tsx', 'packages/lib/src/__tests__/money.test.ts']);
  });

  it('X-6 also finds .spec.ts(x) files (the apps/e2e Playwright suite uses that extension)', () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'apps/e2e/tests'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps/e2e/tests/org-picker.spec.ts'),
      "test('SEAT-1 the picker shows the org', async ({ page }) => {});\n",
    );
    expect(findTestFiles(root)).toEqual([
      'apps/e2e/tests/org-picker.spec.ts',
      'apps/web/src/negatives.test.tsx',
      'packages/lib/src/__tests__/money.test.ts',
    ]);
    const hits = scanTestFiles(root, findTestFiles(root), ['SEAT-1']);
    expect([...(hits.get('apps/e2e/tests/org-picker.spec.ts') ?? [])]).toEqual(['SEAT-1']);
  });

  it('X-6 scans files into an ID set per file', () => {
    const root = makeRepo();
    const hits = scanTestFiles(root, findTestFiles(root), ['MON-1', 'MON-2', 'X-6']);
    expect([...(hits.get('apps/web/src/negatives.test.tsx') ?? [])]).toEqual(['X-6']);
    expect([...(hits.get('packages/lib/src/__tests__/money.test.ts') ?? [])]).toEqual(['MON-2']);
  });

  it('X-6 exits 0 when every ID is covered or allowlisted, and 1 once a covering test is deleted', () => {
    const root = makeRepo();
    const lines: string[] = [];
    const opts = parseArgs(['--offline']);
    expect(run(root, opts, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe('spec-coverage: OK');

    fs.writeFileSync(path.join(root, 'apps/web/src/negatives.test.tsx'), "describe('negatives', () => {});\n");
    const failing: string[] = [];
    expect(run(root, opts, (l) => failing.push(l))).toBe(1);
    expect(failing.join('\n')).toContain('FAIL: no live test names these IDs: X-6');
  });

  it('X-6 --json emits the report with the spec origin', () => {
    const root = makeRepo();
    const lines: string[] = [];
    expect(run(root, parseArgs(['--offline', '--json']), (l) => lines.push(l))).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { origin: string; ok: boolean; missing: string[] };
    expect(parsed.origin).toBe('snapshot');
    expect(parsed.ok).toBe(true);
    expect(parsed.missing).toEqual([]);
  });

  it('X-6 fails loudly when the snapshot is missing and the page is not read', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, 'docs/specs/organizations-wallets.md'));
    expect(() => run(root, parseArgs(['--offline']), () => {})).toThrow(/Spec snapshot not found/);
  });
});
