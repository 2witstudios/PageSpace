import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A CommonJS consumer (control-plane: `"module": "commonjs"`) resolves a
 * `@pagespace/lib/<subpath>` import's types through `typesVersions`, not the
 * `exports` map. A subpath with only an `exports` entry typechecks in every ESM
 * consumer and vitest, then fails control-plane's typecheck with TS2307 the day
 * it is first imported there (073bb39ad).
 */

const repoRoot = resolve(__dirname, '../../../..');
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  typesVersions: { '*': Record<string, string[]> };
};
const typesVersions = pkg.typesVersions['*'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function controlPlaneLibSubpaths(): string[] {
  const subpaths = sourceFiles(join(repoRoot, 'apps/control-plane/src')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/from '@pagespace\/lib\/([^']+)'/g)].map((m) => m[1]),
  );
  return [...new Set(subpaths)].sort();
}

// Pure agent-signup billing helpers a CommonJS consumer may import next.
const COMMONJS_READY = ['billing/classify-gate-refusal', 'billing/stripe-customer-eligibility'];

describe('@pagespace/lib typesVersions', () => {
  it('given a subpath control-plane imports, should map its types for CommonJS resolution', () => {
    const imported = controlPlaneLibSubpaths();
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((subpath) => !typesVersions[subpath])).toEqual([]);
  });

  it('given the agent-signup billing subpaths, should map each to the .d.ts its exports entry names', () => {
    for (const subpath of COMMONJS_READY) {
      const exported = pkg.exports[`./${subpath}`] as { types: string } | undefined;
      expect(exported?.types).toBe(`./dist/${subpath}.d.ts`);
      expect(typesVersions[subpath]).toEqual([exported?.types]);
    }
  });
});
