/**
 * Guardrail: keeps hand-written "N workspace tools" copy in sync with the actual
 * tool registry. `WORKSPACE_TOOL_COUNT` is derived from `TOOL_MODULES` (see
 * `core/ai-tools.ts`), so it is the single source of truth. When a tool is added or
 * removed the count updates automatically and this test goes red until every doc
 * line below is corrected.
 *
 * This is deliberately a monorepo-level invariant: it reads docs that live OUTSIDE
 * apps/web (the repo-root README, the marketing app) and checks them against the
 * web-owned registry. That cross-package read is the whole point — it's the only
 * place that can both import the registry and see the docs. To stay robust when the
 * web package is checked out or built in isolation (e.g. a Docker context that copies
 * only apps/web), each doc read is guarded by existsSync and skipped if the file
 * isn't present; the full-monorepo CI checkout always has them, so the invariant is
 * enforced there.
 *
 * Adding a new doc line that cites the count = add one entry to DOC_COUNT_ASSERTIONS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageSpaceTools } from '../ai-tools';
// The registry surface is imported through its public barrel (apps/web/src/lib/ai/tools).
import { TOOL_REGISTRY, WORKSPACE_TOOL_NAMES, WORKSPACE_TOOL_COUNT } from '../../tools';

// This test lives at apps/web/src/lib/ai/core/__tests__/ — the monorepo root is a
// fixed 7 levels up.
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
  it('WORKSPACE_TOOL_COUNT equals the code-exec-off registry minus exactly the chat-only session family', () => {
    // The chat-only session tools register on every deployment (sessions are
    // free everywhere, review #2326) but are deliberately NOT part of the
    // public workspace-tool count — like the compute tools, they live outside
    // TOOL_MODULES. This pins the off-build to workspace tools + exactly that
    // family, so a new always-on extra can't silently skew the doc count.
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    const workspaceNames = new Set(WORKSPACE_TOOL_NAMES);
    const extras = Object.keys(base).filter((name) => !workspaceNames.has(name));
    expect(new Set(extras)).toEqual(
      new Set([
        'list_sessions',
        'spawn_session',
        'send_session',
        'read_session',
        'kill_session',
        // The LAYOUT family (issue #2208) is chat-only for the same reason the
        // worker verbs are: arranging your own pane grid touches no sandbox,
        // so gating it on the compute kill-switch would hide a chat capability
        // behind a compute flag. Outside TOOL_MODULES too, so the public
        // workspace-tool count (and every doc that cites it) is unchanged.
        'list_panes',
        'resize_pane',
        'move_pane',
        'arrange_panes',
      ]),
    );
    expect(WORKSPACE_TOOL_COUNT).toBe(Object.keys(base).length - extras.length);
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
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) {
        // The web package is checked out/built in isolation — the doc isn't here to
        // validate. CI runs the full monorepo checkout, where this always resolves.
        return;
      }
      const contents = readFileSync(path, 'utf8');
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
