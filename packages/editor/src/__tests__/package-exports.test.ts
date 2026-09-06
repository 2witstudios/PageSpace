/**
 * `@pagespace/editor` is barrel-free and subpath-only, like `@pagespace/lib`
 * (`docs/adr/0001-sdk-api-versioning.md`): there is no `main`, no `types`,
 * no `"."` export. A subpath that is missing from `exports` is unresolvable
 * for every consumer (`ERR_PACKAGE_PATH_NOT_EXPORTED` / TS2307), and one
 * missing from `typesVersions` is unresolvable for the root tsconfig, whose
 * `moduleResolution: "node"` ignores `exports` entirely. This locks the
 * three views — src modules, `exports`, `typesVersions` — to each other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Manifest = {
  name: string;
  type?: string;
  main?: string;
  types?: string;
  exports: Record<string, { types?: string; import?: string; default?: string }>;
  typesVersions: Record<string, Record<string, string[]>>;
};

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Manifest;

const srcModules = readdirSync(join(PKG_DIR, 'src'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

describe('@pagespace/editor package surface', () => {
  it('is barrel-free and subpath-only: no main, no types, no "." export', () => {
    expect(manifest.main).toBeUndefined();
    expect(manifest.types).toBeUndefined();
    expect(manifest.exports['.']).toBeUndefined();
  });

  it('ships an ESM dist — tiptap-markdown has no loadable CommonJS build in Node', () => {
    // `tiptap-markdown` resolves its `require` condition to a UMD file inside
    // a `"type": "module"` package, which Node evaluates as ESM and which
    // then cannot see its own `require`. A CommonJS dist of this package
    // therefore fails to load in Node — exactly the consumer (`apps/collab`)
    // this package exists for. Verified before switching (PR scaffold report).
    expect(manifest.type).toBe('module');
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      expect(entry, subpath).not.toHaveProperty('require');
    }
  });

  it('every src module has a matching exports entry pointing at dist', () => {
    const exported = Object.keys(manifest.exports).map((k) => k.replace(/^\.\//, '')).sort();
    expect(exported).toEqual(srcModules);
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      const name = subpath.replace(/^\.\//, '');
      expect(entry.types).toBe(`./dist/${name}.d.ts`);
      expect(entry.import).toBe(`./dist/${name}.js`);
      expect(entry.default).toBe(`./dist/${name}.js`);
    }
  });

  it('every exports entry has a mirrored typesVersions entry (root tsconfig is moduleResolution: node)', () => {
    const mirrored = manifest.typesVersions['*'];
    expect(mirrored).toBeDefined();
    expect(Object.keys(mirrored).sort()).toEqual(srcModules);
    for (const name of srcModules) {
      expect(mirrored[name]).toEqual([`./dist/${name}.d.ts`]);
    }
  });
});
