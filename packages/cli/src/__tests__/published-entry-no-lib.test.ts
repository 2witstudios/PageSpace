/**
 * The published package must stay loadable without `@pagespace/lib` (a
 * devDependency that ordinary installs omit): nothing reachable by STATIC
 * import from `dist/index.js` may import it. The daemon commands, which do,
 * are reached only through the dynamic imports in `commands/env/lazy.ts`.
 * Reads the built output (`pretest` builds it) and walks every static
 * import/export-from edge.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', '..', 'dist');
const STATIC_EDGE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;

function staticEdges(file: string): string[] {
  const out: string[] = [];
  for (const match of readFileSync(file, 'utf8').matchAll(STATIC_EDGE)) out.push(match[1]!);
  return out;
}

describe('published entry point (dist/index.js) never statically reaches @pagespace/lib', () => {
  it('walks every static edge from dist/index.js', () => {
    expect(existsSync(join(DIST, 'index.js')), 'dist/index.js must be built before this test (pretest does)').toBe(true);
    const seen = new Set<string>();
    const offenders: string[] = [];
    const stack = [join(DIST, 'index.js')];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticEdges(file)) {
        if (spec.startsWith('@pagespace/lib')) offenders.push(`${file.slice(DIST.length + 1)} -> ${spec}`);
        else if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec));
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('the daemon modules DO import @pagespace/lib (sanity: the walk above is not vacuous) and are reached only lazily', () => {
    expect(staticEdges(join(DIST, 'env-bridge', 'dispatcher.js')).some((spec) => spec.startsWith('@pagespace/lib'))).toBe(true);
    const lazy = readFileSync(join(DIST, 'commands', 'env', 'lazy.js'), 'utf8');
    expect(lazy).toMatch(/await import\('\.\/connect\.js'\)/);
    expect(staticEdges(join(DIST, 'commands', 'env', 'lazy.js')).filter((spec) => spec.startsWith('.'))).toEqual([]);
  });
});
