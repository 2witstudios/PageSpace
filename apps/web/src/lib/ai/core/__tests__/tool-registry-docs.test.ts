/**
 * Guardrail: keeps hand-written "N workspace tools" copy in sync with the actual
 * tool registry. `WORKSPACE_TOOL_COUNT` is derived from `TOOL_MODULES` (see
 * `core/ai-tools.ts`), so it is the single source of truth. When a tool is added or
 * removed the count updates automatically and this test goes red until every doc
 * line below is corrected.
 *
 * Adding a new doc line that cites the count = add one entry to DOC_COUNT_ASSERTIONS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Import through the public barrel (apps/web/src/lib/ai/tools) — the discoverable
// entry point the registry is meant to be consumed from.
import {
  TOOL_REGISTRY,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_COUNT,
  buildPageSpaceTools,
} from '../../tools';

// This test lives at apps/web/src/lib/ai/core/__tests__/ — the monorepo root is a
// fixed 7 levels up (matches the fixed-relative-path style used by sibling tests).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

/**
 * Every hand-written mention of the workspace-tool count. `re` MUST be global (`/g`)
 * and capture the number in group 1 — the test checks EVERY match in the file, so a
 * second, stale count can't slip through. Keep this list complete.
 */
const DOC_COUNT_ASSERTIONS: Array<{ file: string; re: RegExp }> = [
  { file: 'README.md', re: /\*\*(\d+)\s+workspace tools\*\*/g },
  {
    file: 'apps/marketing/src/app/docs/getting-started/page.tsx',
    re: /which of the (\d+)\s+workspace tools/g,
  },
];

describe('tool registry — internal consistency', () => {
  it('WORKSPACE_TOOL_COUNT equals the base (code-exec-off) registry size', () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    expect(WORKSPACE_TOOL_COUNT).toBe(Object.keys(base).length);
    expect(WORKSPACE_TOOL_COUNT).toBe(WORKSPACE_TOOL_NAMES.length);
    expect(WORKSPACE_TOOL_COUNT).toBeGreaterThan(0);
  });

  it('every TOOL_REGISTRY category is non-empty and its tools are real workspace tools', () => {
    const names = new Set(WORKSPACE_TOOL_NAMES);
    for (const [category, tools] of Object.entries(TOOL_REGISTRY)) {
      expect(tools.length, `category "${category}" is empty`).toBeGreaterThan(0);
      for (const t of tools) {
        expect(names.has(t), `${category}.${t} is not in WORKSPACE_TOOL_NAMES`).toBe(true);
      }
    }
  });
});

describe('docs cite the derived workspace-tool count', () => {
  for (const { file, re } of DOC_COUNT_ASSERTIONS) {
    it(`every "N workspace tools" mention in ${file} equals ${WORKSPACE_TOOL_COUNT}`, () => {
      const contents = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const counts = [...contents.matchAll(re)].map((m) => Number(m[1]));

      expect(
        counts.length,
        `Found no "N workspace tools" count in ${file} (regex ${re}). ` +
          `If the copy moved, update DOC_COUNT_ASSERTIONS in this test.`,
      ).toBeGreaterThan(0);

      for (const found of counts) {
        expect(
          found,
          `${file} cites ${found} workspace tools, but the registry has ${WORKSPACE_TOOL_COUNT}. ` +
            `The count is derived from apps/web/src/lib/ai/core/ai-tools.ts — update every ` +
            `doc mention to ${WORKSPACE_TOOL_COUNT}; do not change the registry to match a doc.`,
        ).toBe(WORKSPACE_TOOL_COUNT);
      }
    });
  }
});
