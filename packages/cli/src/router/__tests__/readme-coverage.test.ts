/**
 * Every routed verb must appear in the published README.
 *
 * `README.md` carries a hand-maintained command list, and nothing tied it to
 * the router — so six `sheets` verbs shipped routed, built, and documented
 * everywhere except the file a user actually reads.
 *
 * Reads `routes.ts` as TEXT rather than importing `ROUTES`. Importing pulls
 * every command handler — and through `mcp/serve.ts`, the MCP SDK — into this
 * test's module graph, which buys nothing for a documentation check while
 * adding real collection cost to the suite and padding the coverage denominator
 * with modules the test never exercises. A docs check is inherently static, so
 * it reads the source statically.
 *
 * The parser guards itself: finding no routes at all fails, so a change to the
 * shape of `routes.ts` surfaces as a broken guard instead of one that silently
 * passes without checking anything.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), 'utf-8');

/** Pure: every `path: [...]` entry in the router table, as verb strings. */
function routedVerbs(routesSource: string): string[] {
  return [...routesSource.matchAll(/path:\s*\[([^\]]+)\]/g)].map((match) =>
    (match[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter((part) => part.length > 0)
      .join(' '),
  );
}

describe('README command coverage', () => {
  const verbs = routedVerbs(read('../routes.ts'));
  const readme = read('../../../README.md');

  it('finds the route table at all', () => {
    // Without this, a reshaped routes.ts turns the check below into a no-op
    // that passes by finding nothing to check.
    expect(verbs.length).toBeGreaterThan(20);
  });

  it('documents every routed verb', () => {
    const undocumented = verbs.filter((verb) => {
      const last = verb.split(' ').pop() ?? '';
      return !new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(readme);
    });

    expect(
      undocumented,
      `routed verbs missing from packages/cli/README.md:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });
});
