/**
 * authorizeOrgDeparture skips the org's sign-in policy because leaving only restricts (review #2866 B). Any other route
 * using it would act on the org without the policy, so its callers are pinned here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = join(__dirname, '..', '..', '..');
const ALLOWED = ['app/api/orgs/[orgId]/leave/route.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the sign-in-free org gate', () => {
  it('SEC-2 (partial) only the leave route calls authorizeOrgDeparture', () => {
    const callers = sourceFiles(WEB_SRC)
      .filter((path) => readFileSync(path, 'utf8').includes('authorizeOrgDeparture('))
      .map((path) => relative(WEB_SRC, path))
      .filter((path) => path !== 'lib/orgs/org-route-auth.ts');
    expect(callers.sort()).toEqual(ALLOWED);
  });
});
