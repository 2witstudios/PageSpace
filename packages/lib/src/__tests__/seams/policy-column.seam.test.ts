/**
 * POL-1 seam: "policies are stored once per org and read through one function; no route reads the org row
 * directly". The one reader is organizations/policy-reader.ts (getOrgPolicies and its siblings, including the
 * writer's locked read). Every other module, in every package and app, is parsed with the TypeScript compiler and
 * may touch the organizations TABLE only in shapes that name their columns (never `policies`): a whole row, an
 * unclassified use of the table, the relational API and raw SQL that reads it with `*` or `policies` all fail. The
 * schema definition files are the table itself and are not scanned. See policy-column-scan.ts.
 */
import { describe, expect, it } from 'vitest';
import { listSourceFiles } from './walk';
import { scanPolicyColumnReads, scanSourceForPolicyColumnReads } from './policy-column-scan';

const POLICY_READER = 'packages/lib/src/organizations/policy-reader.ts';
const ROOTS = ['packages', 'apps'] as const;
/** The table's own definition (columns, relations, the schema barrel): not a read. */
const SCHEMA_DEFINITION = /^packages\/db\/src\/schema(?:\.ts$|\/)/;

const hits = (source: string): string[] => scanSourceForPolicyColumnReads('probe.ts', source).map((h) => h.what);
const imp = "import { organizations, orgMembers } from '@pagespace/db/schema/organizations';\n";

describe('the organizations.policies seam', () => {
  it('POL-1 no module outside the policy reader reads organizations.policies — every use of the organizations table names its columns, and no whole row, relation or raw SQL reaches it', () => {
    const files = listSourceFiles(ROOTS).filter((f) => !SCHEMA_DEFINITION.test(f));
    expect(files.length).toBeGreaterThan(1000);
    const offenders = scanPolicyColumnReads(files.filter((f) => f !== POLICY_READER));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.what}`)).toEqual([]);
    // The reader really does read it, so the scan cannot pass by matching nothing.
    expect(scanPolicyColumnReads([POLICY_READER]).map((o) => o.what)).toContain('organizations.policies');
  });

  it('the scanner reports every shape of read it exists to catch, each on its own', () => {
    // The column, by any route to the table object.
    expect(hits(`${imp}db.select({ p: organizations.policies }).from(organizations);`)).toEqual(['organizations.policies']);
    expect(hits("import { organizations as o } from '@pagespace/db/schema';\nconst c = o.policies;")).toEqual(['organizations.policies']);
    expect(hits("import * as schema from '@pagespace/db/schema';\nconst c = schema.organizations.policies;")).toEqual(['organizations.policies']);
    expect(hits(`${imp}const t = organizations;\nconst c = t.policies;`)).toEqual(['organizations.policies']);
    expect(hits(`${imp}const x = organizations['policies'];`)).toEqual(['unclassified use of the organizations table']);
    expect(hits(`${imp}const { policies } = organizations;`)).toEqual(['unclassified use of the organizations table']);
    expect(hits(`${imp}type Row = typeof organizations.$inferSelect;\nconst cols = organizations.$inferSelect;`)).toEqual(['organizations.$inferSelect']);
    // Whole rows.
    expect(hits(`${imp}await db.select().from(organizations);`)).toEqual(['whole row: from(organizations) under an unnamed select']);
    expect(hits(`${imp}await db.select().from(orgMembers).innerJoin(organizations, eq(orgMembers.orgId, organizations.id));`)).toEqual(['whole row: innerJoin(organizations) under an unnamed select']);
    expect(hits(`${imp}await db.select({ m: orgMembers.id, org: organizations }).from(orgMembers).leftJoin(organizations, w);`)).toEqual(['unclassified use of the organizations table', 'whole row: leftJoin(organizations) under an unnamed select']);
    expect(hits(`${imp}await db.select({ ...getTableColumns(orgMembers) }).from(organizations);`)).toEqual(['whole row: from(organizations) under an unnamed select']);
    expect(hits(`${imp}getTableColumns(organizations);`)).toEqual(['unclassified use of the organizations table']);
    expect(hits(`${imp}await db.update(organizations).set(v).where(w).returning();`)).toEqual(['whole row: update(organizations).returning()']);
    expect(hits(`${imp}await db.insert(organizations).values(v).returning();`)).toEqual(['whole row: insert(organizations).returning()']);
    expect(hits(`${imp}await db.delete(organizations).where(w).returning();`)).toEqual(['whole row: delete(organizations).returning()']);
    expect(hits(`${imp}await readAll(organizations);`)).toEqual(['unclassified use of the organizations table']);
    // The relational API.
    expect(hits('await db.query.organizations.findFirst();')).toEqual(['query.organizations']);
    expect(hits('await db.query.organizations.findMany({ columns: { id: true } });')).toEqual(['query.organizations']);
    expect(hits("await db.query['organi' + 'zations'].findFirst();")).toEqual(['query[…]']);
    expect(hits('await db.query.orgMembers.findMany({ with: { organization: true } });')).toEqual(['with: { organization } relation']);
    expect(hits('await db.query.drives.findFirst({ with: { organization: { columns: { id: true } } } });')).toEqual(['with: { organization } relation']);
    // Raw SQL.
    expect(hits('await db.execute(sql`select policies from organizations where id = ${id}`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select * from organizations`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select o.* from "organizations" o`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select m.id from org_members m join organizations o on o.id = m."orgId" where o.policies ? ${k}`);')).toEqual(['raw sql text']);
    expect(hits(`${imp}await db.execute(sql\`select * from \${organizations}\`);`)).toEqual(['raw sql text']);
    expect(hits("const q = 'SELECT policies FROM organizations';\nawait db.execute(sql.raw(q));")).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`update organizations set name = ${n} returning *`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select row_to_json(o) from organizations o`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select to_jsonb(o) as org from organizations o where o.id = ${id}`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select json_agg(o) from organizations o`);')).toEqual(['raw sql text']);
    expect(hits("await db.execute(sql`select ${sql.identifier('policies')} from organizations where id = ${id}`);")).toEqual(['raw sql text']);
    expect(hits("await db.execute(sql`select ${sql.raw('policies')} from organizations`);")).toEqual(['raw sql text']);
    // A table from a dynamic import or require, destructured or read off it.
    expect(hits("const { organizations } = await import('@pagespace/db/schema/organizations');\nconst c = organizations.policies;")).toEqual(['organizations.policies']);
    expect(hits("const { organizations: t } = require('@pagespace/db/schema');\nawait db.select().from(t);")).toEqual(['whole row: from(organizations) under an unnamed select']);
    expect(hits("const schema = await import('@pagespace/db/schema');\nconst c = schema.organizations.policies;")).toEqual(['organizations.policies']);
    expect(hits("const c = (await import('@pagespace/db/schema/organizations')).organizations.policies;")).toEqual(['organizations.policies']);
  });

  it('the scanner leaves alone the shapes that name their columns', () => {
    expect(hits(`${imp}await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));`)).toEqual([]);
    expect(hits(`${imp}await db.select({ id: orgMembers.id, name: organizations.name }).from(orgMembers).innerJoin(organizations, eq(orgMembers.orgId, organizations.id));`)).toEqual([]);
    expect(hits(`${imp}await tx.update(organizations).set({ policies: stored }).where(w);`)).toEqual([]);
    expect(hits(`${imp}await db.update(organizations).set(v).returning({ id: organizations.id });`)).toEqual([]);
    expect(hits(`${imp}await db.delete(organizations).where(eq(organizations.id, id));`)).toEqual([]);
    expect(hits(`${imp}const RECORD = { id: organizations.id, name: organizations.name } as const;\nawait db.select(RECORD).from(organizations);\nawait db.insert(organizations).values(v).returning(RECORD);`)).toEqual([]);
    expect(hits(`${imp}const RECORD = { ...getTableColumns(organizations) };\nawait db.select(RECORD).from(organizations);`)).toEqual(['unclassified use of the organizations table', 'whole row: from(organizations) under an unnamed select']);
    expect(hits(`${imp}await db.execute(sql\`select id from \${organizations} where slug = \${s}\`);`)).toEqual([]);
    expect(hits("await db.execute(sql`select ${sql.identifier('name')} from organizations where id = ${id}`);")).toEqual([]);
    expect(hits("const { orgMembers } = await import('@pagespace/db/schema/organizations');")).toEqual([]);
    expect(hits('// select * from organizations\nconst a = 1;')).toEqual([]);
    expect(hits("const label = 'Organization policies';")).toEqual([]);
    expect(hits("import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';")).toEqual([]);
    // A local of the same name that is not the table (a component prop) is not the table.
    expect(hits('function List({ organizations }: { organizations: Org[] }) { return organizations[0]?.id ?? organizations.find(Boolean); }')).toEqual([]);
  });
});
