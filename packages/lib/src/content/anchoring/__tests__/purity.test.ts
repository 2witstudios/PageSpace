import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The anchoring primitive is a pure core: every function in it is a function of
 * its arguments alone. Mirrors the contract asserted for page-webhook-core.
 */
const MODULES = ['types', 'text-projection', 'anchor', 'reanchor', 'resolve'] as const;

/** The only non-relative import the core is allowed to make. */
const ALLOWED_PACKAGE_IMPORTS = new Set(['diff-match-patch']);

function readModule(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}.ts`, import.meta.url)), 'utf8');
}

describe('anchoring purity', () => {
  it.each(MODULES)('%s does no I/O and reads no ambient state', (name) => {
    const src = readModule(name);

    expect(src).not.toMatch(/from ['"][^'"]*\/db['"]/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bnew DOMParser\b/);
    expect(src).not.toMatch(/\bwindow\./);
    expect(src).not.toMatch(/\bglobalThis\./);
  });

  it.each(MODULES)('%s imports nothing beyond the anchoring core and diff-match-patch', (name) => {
    const src = readModule(name);
    const specifiers = [...src.matchAll(/^import[^'"]*from ['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        continue;
      }
      expect(ALLOWED_PACKAGE_IMPORTS.has(specifier), `unexpected import: ${specifier}`).toBe(true);
    }
  });
});

/**
 * Every diff-match-patch entry point the core uses must have its deadline
 * pinned. The library default is a one-second timeout after which diff_main
 * returns a suboptimal — and therefore machine-speed-dependent — diff, which
 * would make the same anchor resolve differently on a fast host than on a
 * loaded one.
 */
describe('anchoring determinism', () => {
  it('resolve.ts pins every dmp knob it relies on', () => {
    const src = readModule('resolve');
    expect(src).toMatch(/dmp\.Diff_Timeout = 0;/);
    expect(src).toMatch(/dmp\.Match_Threshold = [\d.]+;/);
    expect(src).toMatch(/dmp\.Match_Distance = \d+;/);
  });

  it('reanchor.ts pins the diff it delegates to diff-utils', () => {
    const src = readModule('reanchor');
    const call = src.match(/diffContent\([^)]*\)/s);
    expect(call).not.toBeNull();
    expect(call?.[0]).toContain('timeout: 0');
    expect(call?.[0]).toContain("format: 'text'");
  });

  it('the core reaches diff-match-patch only through those two pinned paths', () => {
    // A new module constructing its own DiffMatchPatch would inherit the
    // unpinned defaults, so the import itself is the thing to keep scarce.
    const importers = MODULES.filter((name) => readModule(name).includes('diff-match-patch'));
    expect(importers).toEqual(['resolve']);
  });
});
