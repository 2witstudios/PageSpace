/**
 * IMG-5.1 — no code path inserts an `agent_workspaces` row with a null `driveId`.
 *
 * Two halves, because either alone can be routed around:
 *
 *  - STRUCTURAL: the store's insert input types `driveId` as `string`, so a
 *    caller that tries to write null is a compile error (`bun run typecheck`
 *    checks this file). `spawnAgentSession` — the only production caller —
 *    resolves the owner's Home drive before it reaches the store.
 *  - EXHAUSTIVE: a scan of every non-test source file in the monorepo for an
 *    insert into the table, Drizzle or raw SQL. The only site allowed is the
 *    store, so a new insert path elsewhere fails here and has to be looked at.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { NewAgentSessionInput } from '../agent-workspaces-store';

const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', 'out', 'coverage', 'drizzle', '__tests__', '.turbo']);
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js)$/;
const INSERT_SITE = /\.insert\(\s*agentWorkspaces\s*\)|insert\s+into\s+"?agent_workspaces"?/i;

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(entry) ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) ? [path] : [];
  });
}

describe('agent_workspaces insert sites', () => {
  it('should type the store insert driveId as non-null', () => {
    expectTypeOf<NewAgentSessionInput['driveId']>().toEqualTypeOf<string>();
  });

  it('given every non-test source file, should find inserts only in the store', () => {
    const sites = SCAN_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
      .filter((file) => INSERT_SITE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(sites).toEqual(['packages/lib/src/services/agent-workspaces/agent-workspaces-store.ts']);
  });
});
