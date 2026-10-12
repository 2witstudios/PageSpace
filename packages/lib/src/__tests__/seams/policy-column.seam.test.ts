/**
 * POL-1 seam: "policies are stored once per org and read through one function; no route reads the org row
 * directly". The one reader is organizations/policy-reader.ts (getOrgPolicies and its siblings, including the
 * writer's locked read). Every other module, in every package and app, is parsed with the TypeScript compiler and
 * must not reach the `organizations.policies` column: not through the Drizzle column, not through a whole row, and
 * not through raw SQL text. See policy-column-scan.ts for exactly what counts as a read.
 */
import { describe, expect, it } from 'vitest';
import { listSourceFiles } from './walk';
import { scanPolicyColumnReads, scanSourceForPolicyColumnReads } from './policy-column-scan';

const POLICY_READER = 'packages/lib/src/organizations/policy-reader.ts';
const ROOTS = ['packages', 'apps'] as const;

const hits = (source: string): string[] => scanSourceForPolicyColumnReads('probe.ts', source).map((h) => h.what);

describe('the organizations.policies column seam', () => {
  it('POL-1 no module outside the policy reader reads organizations.policies — by Drizzle column, whole row, or raw SQL text', () => {
    const files = listSourceFiles(ROOTS);
    expect(files.length).toBeGreaterThan(1000);
    const offenders = scanPolicyColumnReads(files.filter((f) => f !== POLICY_READER));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.what}`)).toEqual([]);
    // The reader really does read it, so the scan cannot pass by matching nothing.
    expect(scanPolicyColumnReads([POLICY_READER]).length).toBeGreaterThan(0);
  });

  it('the scanner reports every shape of read it exists to catch', () => {
    const imp = "import { organizations } from '@pagespace/db/schema/organizations';\n";
    expect(hits(`${imp}db.select({ p: organizations.policies }).from(organizations);`)).toEqual(['organizations.policies']);
    expect(hits(`${imp}const x = organizations['policies'];`)).toEqual(['organizations[…]']);
    expect(hits(`${imp}const { policies } = organizations;`)).toEqual(['destructure organizations']);
    expect(hits("import { organizations as o } from '@pagespace/db/schema';\nconst c = o.policies;")).toEqual(['organizations.policies']);
    expect(hits(`${imp}await db.select().from(organizations);`)).toEqual(['select().from(organizations)']);
    expect(hits(`${imp}getTableColumns(organizations);`)).toEqual(['getTableColumns(organizations)']);
    expect(hits(`${imp}await db.update(organizations).set(v).where(w).returning();`)).toEqual(['returning() on organizations']);
    expect(hits('await db.query.organizations.findFirst();')).toEqual(['query.organizations']);
    expect(hits("await db.query['organi' + 'zations'].findFirst();")).toEqual(['query[…]']);
    expect(hits('await db.execute(sql`select policies from organizations where id = ${id}`);')).toEqual(['raw sql text']);
    expect(hits('await db.execute(sql`select o."policies" from "organizations" o`);')).toEqual(['raw sql text']);
    expect(hits(`${imp}await db.execute(sql\`select policies from \${organizations}\`);`)).toEqual(['raw sql text']);
    expect(hits(`${imp}sql\`\${organizations.policies} ? \${key}\`;`)).toEqual(['organizations.policies']);
    expect(hits("const q = 'SELECT policies FROM organizations';\nawait db.execute(sql.raw(q));")).toEqual(['raw sql text']);
  });

  it('the scanner leaves alone what is not a read of the column', () => {
    const imp = "import { organizations } from '@pagespace/db/schema/organizations';\n";
    expect(hits(`${imp}await db.select({ id: organizations.id }).from(organizations);`)).toEqual([]);
    expect(hits(`${imp}await tx.update(organizations).set({ policies: stored }).where(w);`)).toEqual([]);
    expect(hits(`${imp}await db.update(organizations).set(v).returning({ id: organizations.id });`)).toEqual([]);
    expect(hits('// select policies from organizations\nconst a = 1;')).toEqual([]);
    expect(hits("const label = 'Organization policies';")).toEqual([]);
    expect(hits("import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';")).toEqual([]);
    expect(hits('const first = organizations[0]?.id;')).toEqual([]);
  });
});
