import { describe, it, expect } from 'vitest';
import {
  matchThresholdBlock,
  buildThresholdBlock,
  parseThresholds,
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

    expect(parseThresholds(found.match[0])).toEqual({ lines: 44, branches: 85, functions: 56, statements: 44 });
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

  it('matches a well-formed sentinel block with CRLF line endings (Windows/core.autocrlf checkouts)', () => {
    const crlfConfig = CONFIG_WITH_PROSE_MENTION.replace(/\n/g, '\r\n');
    const found = matchThresholdBlock(crlfConfig);

    expect(found).not.toBeNull();
    expect(found!.isSentinel).toBe(true);
    expect(found!.match[0]).toContain('lines: 44,');
  });

  it('throws instead of guessing when two well-formed sentinel blocks exist', () => {
    const twoSentinels = `thresholds: {
        /* ratchet:start */
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
        /* ratchet:end */
      },
      other: {
        /* ratchet:start */
        lines: 1,
        branches: 2,
        functions: 3,
        statements: 4,
        /* ratchet:end */
      },`;

    expect(() => matchThresholdBlock(twoSentinels)).toThrow(/2 ratchet:start\/ratchet:end sentinel blocks/);
  });

  it('throws instead of silently falling back to the corrupting plain match when the sentinel is malformed', () => {
    // Trailing text on the ratchet:end line (e.g. from an autoformatter) means
    // the marker no longer occupies its own line — this must NOT silently
    // fall back to PLAIN_REGEX, which would truncate at the first `}` in the
    // per-glob keys below and corrupt the config exactly like the original bug.
    const malformed = `thresholds: {
        /* ratchet:start */
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
        /* ratchet:end */ // do not edit
        'src/lib/foo/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },`;

    expect(() => matchThresholdBlock(malformed)).toThrow(/not a well-formed sentinel block/);
  });
});

describe('parseThresholds', () => {
  it('extracts all four numeric thresholds from a block of text', () => {
    expect(parseThresholds('lines: 44,\nbranches: 85,\nfunctions: 56,\nstatements: 44,')).toEqual({
      lines: 44,
      branches: 85,
      functions: 56,
      statements: 44,
    });
  });

  it('defaults missing keys to 0', () => {
    expect(parseThresholds('lines: 44,')).toEqual({
      lines: 44,
      branches: 0,
      functions: 0,
      statements: 0,
    });
  });
});

describe('buildThresholdBlock', () => {
  it('preserves the sentinel start marker\'s original indentation', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION)!;
    const block = buildThresholdBlock({
      isSentinel: true,
      indent: found.indent,
      thresholds: { lines: 60, branches: 90, functions: 70, statements: 60 },
    });

    expect(block.startsWith(`${found.indent}/* ratchet:start */`)).toBe(true);
    expect(block).toContain('lines: 60,');
    expect(block.endsWith('/* ratchet:end */')).toBe(true);
  });

  it('round-trips through a real rewrite without corrupting the surrounding config', () => {
    const found = matchThresholdBlock(CONFIG_WITH_PROSE_MENTION)!;
    const block = buildThresholdBlock({
      isSentinel: true,
      indent: found.indent,
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
  it('does not throw on valid source', () => {
    expect(() => assertValidSyntax('export default { foo: 1 };\n', 'test-pkg')).not.toThrow();
  });

  it('throws on a corrupted rewrite (unterminated block comment)', () => {
    const corrupted = 'export default {\n  /* ratchet:end */ markers below are load-bearing:\n';
    expect(() => assertValidSyntax(corrupted, 'test-pkg')).toThrow(/test-pkg/);
  });

  it('accepts TS-only syntax (satisfies, type assertions) that a JS-only check would wrongly reject', () => {
    const tsOnlySyntax = `
      interface Thresholds { lines: number }
      const t = { lines: 44 } satisfies Thresholds;
      const u = t as Thresholds;
      export default t;
    `;
    expect(() => assertValidSyntax(tsOnlySyntax, 'test-pkg')).not.toThrow();
  });
});
