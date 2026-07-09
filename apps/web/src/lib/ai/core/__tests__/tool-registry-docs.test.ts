/**
 * Guardrail: keeps hand-written "N workspace tools" copy in sync with the actual
 * tool registry. `WORKSPACE_TOOL_COUNT` is derived from the same objects that build
 * `baseTools` (see `core/ai-tools.ts`), so this is the single source of truth. When
 * a tool is added or removed the count updates automatically and this test goes red
 * until the doc lines below are corrected.
 *
 * Adding a new doc line that cites the count = add one entry to DOC_COUNT_ASSERTIONS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_REGISTRY,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_COUNT,
  buildPageSpaceTools,
} from '../ai-tools';

/** Walk up from this test file to the monorepo root (dir with turbo.json + README.md). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'turbo.json')) && existsSync(join(dir, 'README.md'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate monorepo root from tool-registry-docs.test.ts');
}

/**
 * Every hand-written mention of the workspace-tool count. `re` must capture the
 * number in group 1. Keep this list complete — a mention not listed here can drift.
 */
const DOC_COUNT_ASSERTIONS: Array<{ file: string; re: RegExp }> = [
  { file: 'README.md', re: /\*\*(\d+)\s+workspace tools\*\*/ },
  {
    file: 'apps/marketing/src/app/docs/getting-started/page.tsx',
    re: /which of the (\d+)\s+workspace tools/,
  },
];

describe('tool registry — internal consistency', () => {
  it('every workspace tool belongs to exactly one TOOL_REGISTRY category', () => {
    const categorized = Object.values(TOOL_REGISTRY).flat();
    // No duplicates across categories.
    expect(new Set(categorized).size).toBe(categorized.length);
    // The union of categories is exactly the flat workspace list.
    expect([...categorized].sort()).toEqual([...WORKSPACE_TOOL_NAMES].sort());
  });

  it('WORKSPACE_TOOL_COUNT equals the base (code-exec-off) registry size', () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    expect(WORKSPACE_TOOL_COUNT).toBe(Object.keys(base).length);
    expect(WORKSPACE_TOOL_COUNT).toBe(WORKSPACE_TOOL_NAMES.length);
  });
});

describe('docs cite the derived workspace-tool count', () => {
  const root = findRepoRoot();

  for (const { file, re } of DOC_COUNT_ASSERTIONS) {
    it(`${file} matches WORKSPACE_TOOL_COUNT (${WORKSPACE_TOOL_COUNT})`, () => {
      const contents = readFileSync(join(root, file), 'utf8');
      const match = contents.match(re);
      expect(
        match,
        `Could not find a "N workspace tools" count in ${file} (regex ${re}). ` +
          `If the copy moved, update DOC_COUNT_ASSERTIONS in this test.`,
      ).not.toBeNull();

      const found = Number(match![1]);
      expect(
        found,
        `${file} says ${found} workspace tools, but the registry has ${WORKSPACE_TOOL_COUNT}. ` +
          `The count is derived from apps/web/src/lib/ai/core/ai-tools.ts — update the doc ` +
          `line to ${WORKSPACE_TOOL_COUNT}, do not change the registry to match the doc.`,
      ).toBe(WORKSPACE_TOOL_COUNT);
    });
  }
});
