/**
 * Tests for the evidence-manifest checker.
 *
 * The checker exists to stop the manifest lying, so these tests are mostly about proving each
 * lie is actually caught: a citation to a deleted file, to a renamed test, to a skipped test,
 * and — the one that motivated the whole thing — to a suite no CI job runs.
 *
 * The last block runs the checker against the REAL manifest, so a citation that rots breaks
 * this test rather than merely printing a warning nobody reads.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDeclarations,
  checkManifest,
  loadManifest,
  blankOutLiteralsAndComments,
  type EvidenceManifest,
} from '../check-evidence-manifest';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Build a throwaway repo containing a workflow file and some spec files. */
function scratchRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-check-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const RUNNING_SUITE = {
  runner: 'vitest',
  pathPrefixes: ['specs/'],
  ciEvidence: { workflow: '.github/workflows/ci.yml', contains: 'turbo run test' },
};

const WORKFLOW_THAT_RUNS_IT = 'jobs:\n  unit:\n    steps:\n      - run: turbo run test\n';

describe('parseDeclarations', () => {
  it('given a plain test declaration, should recover the exact name and mark it executing', () => {
    const declarations = parseDeclarations(`test('renders live without reload', async () => {});`);
    expect(declarations).toEqual([
      { name: 'renders live without reload', templated: false, skipped: false, skipReason: undefined },
    ]);
  });

  it.each(['skip', 'fixme', 'todo'])(
    'given a test declared with .%s, should mark it skipped',
    (modifier) => {
      const [declaration] = parseDeclarations(`test.${modifier}('a thing', () => {});`);
      expect(declaration.skipped).toBe(true);
      expect(declaration.skipReason).toBe(`test.${modifier}`);
    }
  );

  it('given a test inside a describe.skip, should mark the TEST skipped too', () => {
    const declarations = parseDeclarations(`
      describe.skip('the whole area', () => {
        it('an inner promise', () => {});
      });
    `);
    const inner = declarations.find((d) => d.name === 'an inner promise');
    expect(inner?.skipped).toBe(true);
    expect(inner?.skipReason).toBe('describe.skip');
  });

  it('given a describe.skip that has CLOSED before a later test, should not leak skip onto it', () => {
    const declarations = parseDeclarations(`
      describe.skip('dormant', () => {
        it('inner', () => {});
      });
      describe('live', () => {
        it('outer', () => {});
      });
    `);
    expect(declarations.find((d) => d.name === 'inner')?.skipped).toBe(true);
    expect(declarations.find((d) => d.name === 'outer')?.skipped).toBe(false);
  });

  it('given Playwright config calls that are not declarations, should ignore them', () => {
    // test.use / setTimeout / hooks all appear in the epic's specs and take no string arg.
    const declarations = parseDeclarations(`
      test.use({ storageState: { cookies: [], origins: [] } });
      test.setTimeout(150_000);
      test.beforeEach(async ({ request }) => {});
      test('the only real one', () => {});
    `);
    expect(declarations.map((d) => d.name)).toEqual(['the only real one']);
  });

  it('given a templated test name, should record it as templated for wildcard matching', () => {
    const [declaration] = parseDeclarations(
      'test(`a dispatch persists through the ${surface} surface`, () => {});'
    );
    expect(declaration).toMatchObject({
      name: 'a dispatch persists through the ${} surface',
      templated: true,
    });
  });

  it('given braces inside strings and comments, should not corrupt describe nesting', () => {
    const declarations = parseDeclarations(`
      describe.skip('has a { brace in the name', () => {
        // a comment with } an unbalanced brace
        it('still inside the skipped describe', () => {});
      });
      it('outside', () => {});
    `);
    expect(declarations.find((d) => d.name === 'still inside the skipped describe')?.skipped).toBe(true);
    expect(declarations.find((d) => d.name === 'outside')?.skipped).toBe(false);
  });
});

describe('blankOutLiteralsAndComments', () => {
  it('should preserve source length so offsets stay valid', () => {
    const source = `const a = "hello {"; // } trailing\nconst b = 1;`;
    expect(blankOutLiteralsAndComments(source)).toHaveLength(source.length);
  });

  it('should remove braces that live inside literals and comments', () => {
    const stripped = blankOutLiteralsAndComments(`x('{{{'); /* }}} */`);
    expect(stripped).not.toContain('{');
    expect(stripped).not.toContain('}');
  });
});

describe('checkManifest failure modes', () => {
  const manifestFor = (evidence: EvidenceManifest['guarantees'][number]['evidence']): EvidenceManifest => ({
    suites: { unit: RUNNING_SUITE },
    guarantees: [{ id: 'g1', guarantee: 'a promise', status: 'proven', evidence }],
  });

  it('given a cited file that does not exist, should report MISSING_FILE', () => {
    const root = scratchRepo({ '.github/workflows/ci.yml': WORKFLOW_THAT_RUNS_IT });
    const violations = checkManifest(
      manifestFor([{ file: 'specs/gone.test.ts', name: 'whatever', suite: 'unit' }]),
      root
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('MISSING_FILE');
  });

  it('given a cited test name the file no longer declares, should report MISSING_TEST', () => {
    const root = scratchRepo({
      '.github/workflows/ci.yml': WORKFLOW_THAT_RUNS_IT,
      'specs/a.test.ts': `it('the name it has now', () => {});`,
    });
    const violations = checkManifest(
      manifestFor([{ file: 'specs/a.test.ts', name: 'the name the manifest remembers', suite: 'unit' }]),
      root
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('MISSING_TEST');
  });

  it.each([
    ['it.skip', `it.skip('the cited one', () => {});`],
    ['test.fixme', `test.fixme('the cited one', () => {});`],
    ['describe.skip', `describe.skip('area', () => { it('the cited one', () => {}); });`],
  ])('given a cited test disabled by %s, should report SKIPPED_TEST', (_label, source) => {
    const root = scratchRepo({
      '.github/workflows/ci.yml': WORKFLOW_THAT_RUNS_IT,
      'specs/a.test.ts': source,
    });
    const violations = checkManifest(
      manifestFor([{ file: 'specs/a.test.ts', name: 'the cited one', suite: 'unit' }]),
      root
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('SKIPPED_TEST');
  });

  it('given a suite whose CI marker is absent from the workflow, should report UNRUN_SUITE', () => {
    // The e2e gap, in miniature: the spec passes locally and no job invokes it.
    const root = scratchRepo({
      '.github/workflows/ci.yml': 'jobs:\n  unit:\n    steps:\n      - run: echo nothing\n',
      'specs/a.test.ts': `it('the cited one', () => {});`,
    });
    const violations = checkManifest(
      manifestFor([{ file: 'specs/a.test.ts', name: 'the cited one', suite: 'unit' }]),
      root
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRUN_SUITE');
  });

  it('given a hand-listed runner and a file not named in the workflow, should report UNRUN_SUITE', () => {
    const root = scratchRepo({
      '.github/workflows/ci.yml': 'run: cd scripts && bunx vitest run __tests__/other.test.ts\n',
      'scripts/__tests__/mine.test.ts': `it('the cited one', () => {});`,
    });
    const manifest: EvidenceManifest = {
      suites: {
        handListed: {
          runner: 'vitest (explicit file list)',
          pathPrefixes: ['scripts/__tests__/'],
          ciEvidence: { workflow: '.github/workflows/ci.yml', contains: 'cd scripts && bunx vitest run' },
          requiresFileListedInCi: true,
        },
      },
      guarantees: [
        {
          id: 'g1',
          guarantee: 'a promise',
          status: 'proven',
          evidence: [{ file: 'scripts/__tests__/mine.test.ts', name: 'the cited one', suite: 'handListed' }],
        },
      ],
    };
    const violations = checkManifest(manifest, root);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('UNRUN_SUITE');
    expect(violations[0].detail).toContain('hand-maintained list');
  });

  it('given every citation valid, should report no violations', () => {
    const root = scratchRepo({
      '.github/workflows/ci.yml': WORKFLOW_THAT_RUNS_IT,
      'specs/a.test.ts': `describe('area', () => { it('the cited one', () => {}); });`,
    });
    expect(
      checkManifest(manifestFor([{ file: 'specs/a.test.ts', name: 'the cited one', suite: 'unit' }]), root)
    ).toEqual([]);
  });

  it('given a templated declaration, should match a cited concrete name', () => {
    const root = scratchRepo({
      '.github/workflows/ci.yml': WORKFLOW_THAT_RUNS_IT,
      'specs/a.test.ts': 'test(`a dispatch through the ${surface} surface`, () => {});',
    });
    expect(
      checkManifest(
        manifestFor([{ file: 'specs/a.test.ts', name: 'a dispatch through the pipeline surface', suite: 'unit' }]),
        root
      )
    ).toEqual([]);
  });
});

describe('gap honesty', () => {
  const gapManifest = (gap?: string): EvidenceManifest => ({
    suites: { unit: RUNNING_SUITE },
    guarantees: [{ id: 'g1', guarantee: 'an unproven promise', status: 'gap', gap }],
  });

  it('given a gap with a TODO(owner) marker, should accept it', () => {
    expect(checkManifest(gapManifest('TODO(epic-owner): no executing evidence yet'), REPO_ROOT)).toEqual([]);
  });

  it('given a gap with no TODO(owner) marker, should report MALFORMED', () => {
    const violations = checkManifest(gapManifest('someone should look at this'), REPO_ROOT);
    expect(violations[0]).toMatchObject({ code: 'MALFORMED' });
  });

  it('given status "proven" with no citations, should report MALFORMED rather than pass vacuously', () => {
    const violations = checkManifest(
      { suites: { unit: RUNNING_SUITE }, guarantees: [{ id: 'g1', guarantee: 'x', status: 'proven', evidence: [] }] },
      REPO_ROOT
    );
    expect(violations[0]).toMatchObject({ code: 'MALFORMED' });
  });
});

describe('the real manifest', () => {
  const manifest = loadManifest(path.join(REPO_ROOT, 'docs/2.0-architecture/agent-sessions-evidence.json'));

  it('should have every citation resolve to an executing test in a CI-run suite', () => {
    expect(checkManifest(manifest, REPO_ROOT)).toEqual([]);
  });

  it('should record every guarantee as either proven or an owned gap', () => {
    for (const guarantee of manifest.guarantees) {
      expect(['proven', 'gap']).toContain(guarantee.status);
      expect(guarantee.guarantee.length).toBeGreaterThan(0);
    }
  });
});
