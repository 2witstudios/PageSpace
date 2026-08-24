/**
 * `read_sheet` must never write. Asserted structurally, not behaviourally.
 *
 * Read-only mode is enforced by stripping `WRITE_TOOLS`, and `read_sheet`
 * cannot be in that set without removing every sheet read; `ToolExecutionContext`
 * carries no read-only signal, so the tool cannot check the toggle itself. The
 * product tells users read-only means "read and search — no writes", so the
 * only thing keeping that promise is the tool importing no write path at all.
 *
 * A behavioural test cannot cover this: it can only prove the writes it thought
 * to look for did not happen on the paths it thought to exercise. This fails the
 * moment a write function is imported, whether or not anything calls it yet —
 * which is the point, because the last time this regressed it arrived as a
 * reasonable-looking `ensureTab` on a path that genuinely needed rows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * BOTH modules, because `read_sheet`'s positional path does almost none of its
 * work in the tool file: `loadSheetWindow` lives in `sheet-view.ts` and is what
 * actually touches the store. Guarding only the tool file left the module where
 * the last regression would naturally be written — "a reasonable-looking
 * `ensureTab` on a path that genuinely needed rows" — completely uncovered, and
 * `read_page` and command injection reach the store through it too.
 */
const SOURCES: Array<[string, string]> = [
  ['sheet-read-tools.ts', readFileSync(resolve(HERE, '../sheet-read-tools.ts'), 'utf-8')],
  ['sheet-view.ts', readFileSync(resolve(HERE, '../sheet-view.ts'), 'utf-8')],
];

/**
 * Every mutating export of `@pagespace/lib/sheets/store`. `ensureTab` and
 * `rebuildTab` are the non-obvious ones: they read like setup, and both insert.
 */
const WRITE_FUNCTIONS = [
  'ensureTab',
  'setCells',
  'appendRows',
  'deleteRows',
  'rebuildTab',
  'copySheetRows',
  'materializeFromDocument',
  'replaceFromDocument',
];

const READ_ONLY_STORE_IMPORTS: Record<string, string[]> = {
  'sheet-read-tools.ts': ['getTab', 'listTabs', 'queryRows'],
  'sheet-view.ts': ['getTab', 'listTabs', 'readRows'],
};

describe('the sheet read path is structurally incapable of writing', () => {
  const cases = SOURCES.flatMap(([name, source]) =>
    WRITE_FUNCTIONS.map((fn) => [name, fn, source] as const),
  );

  it.each(cases)('%s does not reference %s', (name, fn, source) => {
    expect(source.includes(fn), `${name} references ${fn}`).toBe(false);
  });

  it.each(SOURCES)('%s imports from the store only functions that read', (name, source) => {
    const importLine = source.match(/import \{([^}]*)\} from '@pagespace\/lib\/sheets\/store'/);
    expect(importLine, `expected a store import in ${name}`).not.toBeNull();
    const imported = importLine![1].split(',').map((n) => n.trim()).filter(Boolean);
    expect(imported.sort()).toEqual([...READ_ONLY_STORE_IMPORTS[name]].sort());
  });
});
