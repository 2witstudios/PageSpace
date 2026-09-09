import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../../../..');

/**
 * The guard itself (`enforceReadOnlySession`/`assertReadOnlySession`) is
 * tested where it now lives, `@pagespace/db/read-only-session`. What stays
 * here is the census's own promise.
 *
 * The census runs against production with the production credential. "It only
 * reads" has to be checkable without reading the whole script, so it is a test:
 * no census source may contain a write.
 */
describe('the census is read-only by construction', () => {
  // Globbed, not listed: a hand-written inventory is how a file ends up
  // unscanned while the test stays green (the same lesson scripts/vitest.config.ts
  // records). Opting a file out has to be a visible edit here.
  const censusDir = 'src/lib/editor/census';
  const sources = [
    'scripts/collab-content-census.ts',
    ...readdirSync(path.join(appRoot, censusDir))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => `${censusDir}/${entry}`),
  ];

  // Comments are stripped first: the script's own header explains that it never
  // runs an INSERT, and a scanner that cannot tell code from prose would either
  // fail on that sentence or force the sentence out of the file.
  const codeOf = (relative: string) =>
    readFileSync(path.join(appRoot, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const writes = [
    /\.insert\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /\btransaction\s*\(/,
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i,
  ];

  it.each(sources)('%s contains no write', (relative) => {
    const code = codeOf(relative);
    for (const write of writes) {
      expect(code).not.toMatch(write);
    }
  });

  it('scans every census module, not a list that can go stale', () => {
    expect(sources).toContain(`${censusDir}/round-trip.ts`);
    expect(sources.length).toBeGreaterThan(5);
  });

  it('strips comments before scanning, but not code that follows one', () => {
    expect(codeOf('scripts/collab-content-census.ts')).toContain('getMigrationDb');
  });
});
