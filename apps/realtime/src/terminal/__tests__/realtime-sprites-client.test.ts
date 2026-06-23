import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Regression guard for the ESM/CJS terminal bug (PR #1678).
//
// @fly/sprites is ESM-only (its package.json `exports` defines only import/types,
// no require). The realtime service builds with tsc (module:commonjs) and runs
// under plain Node with no bundler, so tsc DOWN-LEVELS a bare
// `await import('@fly/sprites')` into a require() — which Node refuses for an
// import-only package ("No exports main defined"), breaking terminals in prod.
//
// The fix indirects the dynamic import through `new Function('s','return import(s)')`
// so the compiler can't see/transform it and a NATIVE import() survives to runtime.
// This failure is silent at build time (tsc emits clean) and only blows up at
// runtime, so we assert the invariant at the source level where it can be caught
// in CI without building the dist.
describe('realtime-sprites-client ESM loading invariant', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../realtime-sprites-client.ts'),
    'utf8',
  );

  it('does not use a bare dynamic import of @fly/sprites that tsc would lower to require()', () => {
    expect(source).not.toMatch(/await\s+import\(\s*['"]@fly\/sprites['"]\s*\)/);
  });

  it('loads @fly/sprites through an indirect import the compiler cannot down-level', () => {
    expect(source).toMatch(/new Function\([^)]*return import\(/);
    expect(source).toMatch(/importEsm[^)]*\(\s*['"]@fly\/sprites['"]\s*\)/);
  });
});
