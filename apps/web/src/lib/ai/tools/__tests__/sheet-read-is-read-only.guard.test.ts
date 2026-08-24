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
const SOURCE = readFileSync(resolve(HERE, '../sheet-read-tools.ts'), 'utf-8');

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

describe('read_sheet is structurally incapable of writing', () => {
  it.each(WRITE_FUNCTIONS)('does not reference %s', (fn) => {
    expect(SOURCE.includes(fn), `sheet-read-tools.ts references ${fn}`).toBe(false);
  });

  it('imports from the store only functions that read', () => {
    const importLine = SOURCE.match(/import \{([^}]*)\} from '@pagespace\/lib\/sheets\/store'/);
    expect(importLine, 'expected a store import to assert on').not.toBeNull();
    const imported = importLine![1].split(',').map((n) => n.trim()).filter(Boolean);
    expect(imported.sort()).toEqual(['getTab', 'listTabs', 'queryRows'].sort());
  });
});
