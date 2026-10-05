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

/**
 * The IMPORT seam (independent review of #2762, P2-5): regexes over code can always be dodged (a raw SQL string, a
 * join's whole-row result, getTableColumns, an alias), so the guarantee is structural. The `organizations` table
 * object may be imported only by these modules. Each selects named columns (the reader and the writer the only ones
 * naming `policies`), and the repository hands the rest of the app an `OrgRecord` without them. Any other import
 * fails here, and so does a namespace or barrel import of the schema that would reach the table without naming it.
 * Adding a file to this list is a reviewed decision.
 */
const ORGANIZATIONS_IMPORTERS = [
  'apps/web/src/lib/org-billing/org-subscription.ts',
  'packages/lib/src/billing/wallet-funding-shell.ts',
  'packages/lib/src/organizations/deletion.ts',
  'packages/lib/src/organizations/domains.ts',
  'packages/lib/src/organizations/invitations.ts',
  'packages/lib/src/organizations/leave.ts',
  'packages/lib/src/organizations/membership.ts',
  'packages/lib/src/organizations/open-role-floor.ts',
  'packages/lib/src/organizations/policies.ts',
  'packages/lib/src/organizations/policy-reader.ts',
  'packages/lib/src/organizations/repository.ts',
  'packages/lib/src/organizations/seat-service.ts',
  'packages/lib/src/organizations/status.ts',
  'packages/lib/src/repositories/account-repository.ts',
  'packages/lib/src/services/drive-join-request-service.ts',
  'packages/lib/src/services/org-drive-service.ts',
].sort();
const IMPORT_ROOTS = ['packages/lib/src', 'apps'];
/** A named import of the schema module: its specifier list and the module path. */
const NAMED_SCHEMA_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](@pagespace\/db\/schema(?:\/organizations)?)['"]/g;
/** A namespace import of the schema reaches `organizations` without naming it. */
const WHOLE_SCHEMA_IMPORT = /import\s+\*\s+as\s+\w+\s+from\s+['"]@pagespace\/db(?:\/schema(?:\/organizations)?)?['"]/;
/**
 * The namespace importers, each reviewed: page-content-store walks every table object for its content-reference
 * columns (Object.values of the schema) and never selects from organizations.
 */
const SCHEMA_NAMESPACE_IMPORTERS = ['packages/lib/src/services/page-content-store.ts'];

/** A re-export of the table (`export { organizations … } from …`, or `export * from` the schema module). */
const SCHEMA_REEXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](@pagespace\/db\/schema(?:\/organizations)?)['"]|export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"]@pagespace\/db\/schema(?:\/organizations)?['"]/g;
/** A dynamic import of the schema module (re-verify N5). */
const DYNAMIC_SCHEMA_IMPORT = /import\(\s*['"`]@pagespace\/db(?:\/schema(?:\/organizations)?)?['"`]\s*\)/;
/** A computed key on the relational query API, which could name `organizations` without the word (re-verify N5). */
const COMPUTED_QUERY_KEY = /\.query\s*\[/;

function importsOrganizationsTable(code: string): boolean {
  for (const m of code.matchAll(SCHEMA_REEXPORT)) {
    if (m[1] === undefined) return true; // export * re-exports everything, organizations included
    if (m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).includes('organizations')) return true;
  }
  for (const m of code.matchAll(NAMED_SCHEMA_IMPORT)) {
    if (m[1]) continue; // `import type { … }` brings no value
    const names = m[2].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
    if (names.includes('organizations')) return true;
  }
  return false;
}

describe('the organizations table import seam', () => {
  it('POL-1 (partial) only the allowlisted modules import the organizations table object; no file reaches it through a namespace or barrel import', () => {
    const importers: string[] = [];
    const wholeSchema: string[] = [];
    for (const root of IMPORT_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        const code = stripComments(readFileSync(file, 'utf8'));
        if (importsOrganizationsTable(code)) importers.push(rel);
        if (WHOLE_SCHEMA_IMPORT.test(code) || DYNAMIC_SCHEMA_IMPORT.test(code) || COMPUTED_QUERY_KEY.test(code)) wholeSchema.push(rel);
      }
    }
    expect(importers.sort()).toEqual(ORGANIZATIONS_IMPORTERS);
    expect(wholeSchema.sort()).toEqual(SCHEMA_NAMESPACE_IMPORTERS);
  });

  it('the import patterns match the shapes they exist to catch (so they cannot pass by matching nothing)', () => {
    expect(importsOrganizationsTable("import { organizations, orgMembers } from '@pagespace/db/schema/organizations';")).toBe(true);
    expect(importsOrganizationsTable("import { orgMembers, organizations as orgs } from '@pagespace/db/schema/organizations';")).toBe(true);
    expect(importsOrganizationsTable("import { orgMembers, type Organization } from '@pagespace/db/schema/organizations';")).toBe(false);
    expect(importsOrganizationsTable("import type { organizations } from '@pagespace/db/schema/organizations';")).toBe(false);
    expect(WHOLE_SCHEMA_IMPORT.test("import * as orgs from '@pagespace/db/schema/organizations';")).toBe(true);
    expect(importsOrganizationsTable("import { organizations } from '@pagespace/db/schema';")).toBe(true);
    expect(WHOLE_SCHEMA_IMPORT.test("import { sheetRows } from '@pagespace/db/schema';")).toBe(false);
    expect(importsOrganizationsTable("export { organizations as orgTableProbe } from '@pagespace/db/schema/organizations';")).toBe(true);
    expect(importsOrganizationsTable("export * from '@pagespace/db/schema/organizations';")).toBe(true);
    expect(importsOrganizationsTable("export { orgMembers } from '@pagespace/db/schema/organizations';")).toBe(false);
    expect(DYNAMIC_SCHEMA_IMPORT.test("const m = await import('@pagespace/db/schema/organizations');")).toBe(true);
    expect(COMPUTED_QUERY_KEY.test("db.query['organi' + 'zations'].findFirst()")).toBe(true);
  });
});

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
