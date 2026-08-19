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
