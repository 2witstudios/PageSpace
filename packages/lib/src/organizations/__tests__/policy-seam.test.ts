import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The seam guard for "policies are stored once per org and read through one function; no route reads the org
 * row directly". The stored column is `organizations.policies`; the only source files that may name it are
 * the reader (the read) and the writer (the locked read-merge-write of one change). Everything else asks
 * `getOrgPolicies` / `getDrivePolicies` / `readOrgSpendPolicy` / `listOrgsSettingPolicyKeys`.
 */
const REPO_ROOT = resolve(__dirname, '../../../../..');
const ROOTS = ['packages/lib/src', 'packages/db/src', 'apps'];
const ALLOWED = new Set([
  'packages/lib/src/organizations/policy-reader.ts',
  'packages/lib/src/organizations/policies.ts',
  // The column definition itself.
  'packages/db/src/schema/organizations.ts',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__tests__', 'drizzle']);
// A reference to the column, a whole-column select, or a raw-SQL reach into the jsonb.
const COLUMN_READ = /organizations\.policies\b|columns:\s*\{[^}]*\bpolicies\b|["'`]policies["'`]\s*[:,]\s*organizations\b/;

// Code, not prose: a comment may name the column.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('the org policy reader seam', () => {
  it('POL-1 no source file outside the reader and the writer reads the organizations.policies column', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        scanned += 1;
        const rel = relative(REPO_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        if (COLUMN_READ.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel);
      }
    }
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });

  it('the allowed files really do touch the column (so the guard cannot pass by matching nothing)', () => {
    for (const rel of ['packages/lib/src/organizations/policy-reader.ts', 'packages/lib/src/organizations/policies.ts']) {
      expect(stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'))).toMatch(COLUMN_READ);
    }
  });
});
