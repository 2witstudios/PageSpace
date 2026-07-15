import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchThresholdBlock,
  buildThresholdBlock,
  assertValidSyntax,
} from '../lib/coverage-ratchet-sentinel.mjs';

// Mirrors the real corrupting comment from apps/web/vitest.config.ts (#2075):
// a prose line that mentions the marker text literally, directly above the
// real sentinel-delimited threshold block.
const CONFIG_WITH_PROSE_MENTION = `export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        // The /* ratchet:start */.../* ratchet:end */ markers below are load-bearing:
        // some-script.mjs matches this exact comment-delimited region
        /* ratchet:start */
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
        /* ratchet:end */
        'src/lib/foo/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
})
`;

const CONFIG_WITHOUT_SENTINEL = `export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        lines: 50,
        branches: 89,
        functions: 66,
        statements: 50,
      },
    },
  },
})
`;

describe('matchThresholdBlock', () => {
  it('ignores marker text embedded in prose and finds the real sentinel block', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION);

    expect(found).not.toBeNull();
    expect(found!.isSentinel).toBe(true);
    expect(found!.match[0]).toContain('lines: 44,');
    expect(found!.match[0]).toContain('statements: 44,');
    // The fake span from the prose line must not be what matched.
    expect(found!.match[0]).not.toContain('markers below are load-bearing');
  });

  it('extracts the real numeric thresholds, not zeros from a fake match', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION)!;
    const lines = parseInt(found.match[0].match(/lines:\s*(\d+)/)?.[1] ?? '0');
    const branches = parseInt(found.match[0].match(/branches:\s*(\d+)/)?.[1] ?? '0');

    expect(lines).toBe(44);
    expect(branches).toBe(85);
  });

  it('falls back to the plain thresholds block when there is no sentinel', () => {
    const found = matchThresholdBlock(CONFIG_WITHOUT_SENTINEL);

    expect(found).not.toBeNull();
    expect(found!.isSentinel).toBe(false);
    expect(found!.match[0]).toContain('lines: 50,');
  });

  it('returns null when no thresholds block exists at all', () => {
    expect(matchThresholdBlock('export default {}')).toBeNull();
  });
});

describe('buildThresholdBlock', () => {
  it('preserves the sentinel start marker\'s original indentation', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION)!;
    const block = buildThresholdBlock({
      isSentinel: true,
      indent: found.match[1],
      thresholds: { lines: 60, branches: 90, functions: 70, statements: 60 },
    });

    expect(block.startsWith(`${found.match[1]}/* ratchet:start */`)).toBe(true);
    expect(block).toContain('lines: 60,');
    expect(block.endsWith('/* ratchet:end */')).toBe(true);
  });

  it('round-trips through a real rewrite without corrupting the surrounding config', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION)!;
    const block = buildThresholdBlock({
      isSentinel: true,
      indent: found.match[1],
      thresholds: { lines: 60, branches: 90, functions: 70, statements: 60 },
    });
    const rewritten = CONFIG_WITH_PROSE_MENTION.replace(found.regex, block);

    // The prose comment line and the trailing per-glob key must survive untouched.
    expect(rewritten).toContain('markers below are load-bearing');
    expect(rewritten).toContain("'src/lib/foo/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },");
    expect(rewritten).toContain('lines: 60,');
    expect(rewritten).not.toContain('lines: 44,');
  });
});

describe('assertValidSyntax', () => {
  let dir: string;

  it('does not throw on valid source', () => {
    dir = mkdtempSync(join(tmpdir(), 'ratchet-sentinel-test-'));
    try {
      expect(() => assertValidSyntax('export default { foo: 1 };\n', 'test-pkg', dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a corrupted rewrite (unterminated block comment)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ratchet-sentinel-test-'));
    try {
      const corrupted = 'export default {\n  /* ratchet:end */ markers below are load-bearing:\n';
      expect(() => assertValidSyntax(corrupted, 'test-pkg', dir)).toThrow(/test-pkg/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
