/**
 * The published package must stay loadable without `@pagespace/lib` (a
 * workspace devDependency that is not publishable): no file in the BUILT
 * dist may reference it in any runtime import form — static `import … from`,
 * side-effect `import '…'`, `export … from`, dynamic `import('…')` or
 * `require('…')`. The pure core is bundled into `dist/env-bridge/lib-core.js`
 * by `scripts/bundle-lib-core.mjs` (`pretest` builds it). A second check
 * walks the static graph from `dist/index.js` so the entry point itself is
 * proven, not just grepped.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', '..', 'dist');
/** `import x from '…'` / `export … from '…'`, and side-effect `import '…'` */
const STATIC_EDGE = /^\s*(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)['"]([^'"]+)['"]/gm;
/** `import('…')`, `require('…')` */
const DYNAMIC_EDGE = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

function edges(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(STATIC_EDGE), ...source.matchAll(DYNAMIC_EDGE)].map((match) => match[1]!);
}

describe('published dist never references @pagespace/lib at runtime', () => {
  it('no dist/**/*.js has a static, side-effect, dynamic or require edge to @pagespace/lib', () => {
    expect(existsSync(join(DIST, 'index.js')), 'dist must be built before this test (pretest does)').toBe(true);
    const files = jsFiles(DIST);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => edges(file).filter((spec) => spec.startsWith('@pagespace/lib')).map((spec) => `${file.slice(DIST.length + 1)} -> ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('the bundled core is self-contained: dist/env-bridge/lib-core.js defines verifyGrant and imports only zod', () => {
    const core = readFileSync(join(DIST, 'env-bridge', 'lib-core.js'), 'utf8');
    expect(core).toMatch(/function verifyGrant\(/);
    expect(core).toMatch(/function decideExecution\(/);
    const external = edges(join(DIST, 'env-bridge', 'lib-core.js')).filter((spec) => !spec.startsWith('.'));
    // The bundle inlines the pure core; the only externals left are zod (a CLI dep) and node builtins.
    expect(new Set(external)).toEqual(new Set(['zod', 'node:path']));
  });

  it('walks every static edge from dist/index.js (the entry point is proven, not grepped)', () => {
    const seen = new Set<string>();
    const stack = [join(DIST, 'index.js')];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of edges(file)) {
        expect(spec.startsWith('@pagespace/lib'), `${file} -> ${spec}`).toBe(false);
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec));
      }
    }
    expect(seen.has(join(DIST, 'env-bridge', 'lib-core.js'))).toBe(true);
  });

  it('package.json declares @pagespace/lib in no dependency field (it is a devDependency, and not shipped)', () => {
    const pkg = JSON.parse(readFileSync(resolve(DIST, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(pkg[field] ?? {}, field).not.toHaveProperty('@pagespace/lib');
    }
    expect(pkg.devDependencies).toHaveProperty('@pagespace/lib');
    expect(pkg.devDependencies).toHaveProperty('esbuild');
  });

  it('the edge regexes see side-effect imports too (sanity)', () => {
    expect([...`import './setup.js';\nimport x from 'a';\nexport { y } from 'b';`.matchAll(STATIC_EDGE)].map((m) => m[1])).toEqual(['./setup.js', 'a', 'b']);
    expect([...`const m = await import('c'); const n = require("d");`.matchAll(DYNAMIC_EDGE)].map((m) => m[1])).toEqual(['c', 'd']);
  });
});
