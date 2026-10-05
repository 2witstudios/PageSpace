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

// A WHOLE-ROW read of the organizations table carries the column without naming it (Review 3+4 mutant M11): a
// bare select().from(organizations), a bare .returning() on an insert or update of it, or the relational query API.
const WHOLE_ROW_READ = /\.select\(\s*\)\s*\.from\(\s*organizations\s*\)|\b(?:insert|update)\(\s*organizations\s*\)[^;]*?\.returning\(\s*\)|\bquery\.organizations\./;
// The org RECORD producers (organizations/repository.ts). A file that consumes one must not read `policies` off what
// it gets back, as a property or in a destructuring pattern, whatever the producer returns today.
const ORG_RECORD_PRODUCER = /\b(?:findOrganizationById|createOrganization|updateOrganization)\b|\btype\s+Organization\b|\bOrganization\b\s*[,}][^;]*from\s+['"]@pagespace\/db\/schema\/organizations['"]/;
const POLICIES_PROPERTY_READ = /\.\s*policies\b|\{[^{}]*\bpolicies\b[^{}]*\}\s*=/;

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
  it('POL-1 (partial) no source file outside the reader and the writer reads the organizations.policies column', () => {
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

  it('POL-1 (partial) no source file outside the reader and the writer reads a WHOLE organizations row, which would carry the policies column unnamed', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        if (WHOLE_ROW_READ.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('POL-1 (partial) no source file that takes an org record from the repository reads `policies` off it', () => {
    const offenders: string[] = [];
    let consumers = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const code = stripComments(readFileSync(file, 'utf8'));
        if (!ORG_RECORD_PRODUCER.test(code)) continue;
        consumers += 1;
        if (POLICIES_PROPERTY_READ.test(code)) offenders.push(rel);
      }
    }
    // The org routes and the invite and domain mailers consume records; a guard that finds none guards nothing.
    expect(consumers).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it('the whole-row and record-read patterns match the shapes they exist to catch (so they cannot pass by matching nothing)', () => {
    expect(WHOLE_ROW_READ.test('const [row] = await db.select().from(organizations).where(eq(organizations.id, id));')).toBe(true);
    expect(WHOLE_ROW_READ.test('const [org] = await tx.insert(organizations).values(v).returning();')).toBe(true);
    expect(WHOLE_ROW_READ.test('await db.update(organizations).set(patch).where(w).returning();')).toBe(true);
    expect(WHOLE_ROW_READ.test('await db.query.organizations.findFirst({ where })')).toBe(true);
    expect(WHOLE_ROW_READ.test('await db.select({ id: organizations.id }).from(organizations)')).toBe(false);
    expect(WHOLE_ROW_READ.test('await db.update(organizations).set(patch).returning({ id: organizations.id })')).toBe(false);
    expect(POLICIES_PROPERTY_READ.test('const { id, name, policies } = org;')).toBe(true);
    expect(POLICIES_PROPERTY_READ.test('return NextResponse.json({ policies: org.policies });')).toBe(true);
    expect(POLICIES_PROPERTY_READ.test('const { id, name, slug } = org;')).toBe(false);
  });

  it('the allowed files really do touch the column (so the guard cannot pass by matching nothing)', () => {
    for (const rel of ['packages/lib/src/organizations/policy-reader.ts', 'packages/lib/src/organizations/policies.ts']) {
      expect(stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'))).toMatch(COLUMN_READ);
    }
  });
});
