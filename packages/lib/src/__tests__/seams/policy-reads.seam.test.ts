/**
 * Seam guard 1 — one policy reader (Spec POL section; Vision principle 2 "one policy reader").
 *
 * Once the organizations schema exists (lane B1), no API route under apps/web/src/app/api may
 * import the organizations / organization policies table directly: policy reads go through
 * the canonical reader (`getOrgPolicies`, Sequence Spec Wave E contract) so "a policy set to
 * off refuses" (X-6) is decided in exactly one place.
 *
 * The table does not exist yet, so the guard skips cleanly today — visibly, as a skip, not as
 * a vacuous pass — and arms itself the moment a schema file exports the table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, listSourceFiles } from './walk';

const SCHEMA_DIR = 'packages/db/src/schema';
const API_ROOT = 'apps/web/src/app/api';

/** Table identifiers a route must never import from the schema for policy reads. */
export const POLICY_TABLE_IDENTIFIERS = ['organizations', 'organizationPolicies', 'orgPolicies'] as const;

const TABLE_EXPORT = new RegExp(`export\\s+const\\s+(${POLICY_TABLE_IDENTIFIERS.join('|')})\\s*=\\s*pgTable\\b`);

/** True when any schema file exports one of the policy tables. */
export function organizationsSchemaExists(): boolean {
  const dir = path.join(REPO_ROOT, SCHEMA_DIR);
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .some((f) => TABLE_EXPORT.test(fs.readFileSync(path.join(dir, f), 'utf8')));
}

const SCHEMA_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@pagespace\/db\/schema[^'"]*['"]/g;

/** Repo-relative route files that import a policy table identifier from @pagespace/db/schema. */
export function routesImportingPolicyTables(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const m of source.matchAll(SCHEMA_IMPORT)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
      if (names.some((n) => (POLICY_TABLE_IDENTIFIERS as readonly string[]).includes(n))) {
        offenders.push(file);
        break;
      }
    }
  }
  return offenders;
}

describe('X-6 seam: API routes never import the organizations schema for policy reads', () => {
  const armed = organizationsSchemaExists();

  it.skipIf(!armed)('X-6 no route under apps/web/src/app/api imports organizations/organizationPolicies from the schema', () => {
    const offenders = routesImportingPolicyTables(listSourceFiles([API_ROOT]));
    expect(
      offenders,
      'Policy reads go through the canonical reader (getOrgPolicies), never the table:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('X-6 the import detector recognises the table in a named, aliased, or type import', () => {
    const dir = fs.mkdtempSync(path.join(REPO_ROOT, 'packages/lib/.seam-probe-'));
    try {
      const rel = path.relative(REPO_ROOT, dir).split(path.sep).join('/');
      const write = (name: string, body: string): string => {
        fs.writeFileSync(path.join(dir, name), body);
        return `${rel}/${name}`;
      };
      const named = write('a.ts', "import { organizations, drives } from '@pagespace/db/schema/organizations';\n");
      const aliased = write('b.ts', "import {\n  organizationPolicies as pol,\n} from '@pagespace/db/schema';\n");
      const clean = write('c.ts', "import { drives } from '@pagespace/db/schema/drives';\nimport { getOrgPolicies } from '@pagespace/lib/services/org-policies';\n");
      expect(routesImportingPolicyTables([named, aliased, clean])).toEqual([named, aliased]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
