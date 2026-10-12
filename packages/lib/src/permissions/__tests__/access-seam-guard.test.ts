/**
 * D-OW-45: the org sign-in policy (SEC-2/SEC-3) is enforced in ONE seam, and the seam is structural: every access
 * function about "the caller" takes an AccessActor, the userId-only resolvers are module-private, and the few
 * third-party facts (asked about someone who is not presenting a credential) are pinned to the callers that may ask
 * them. This guard documents that and fails the build the day a bypass is reintroduced.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AccessActor } from '../access-actor';
import type * as permissions from '../permissions';
import type * as appPermissions from '../app-permissions';
import type * as memberDrives from '../member-drives';
import type * as relationships from '../drive-relationship-loader';
import type * as accessibleIds from '../accessible-page-ids';
import type * as driveService from '../../services/drive-service';

const REPO = resolve(__dirname, '../../../../..');
const LIB_PACKAGE = JSON.parse(readFileSync(join(REPO, 'packages/lib/package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes('__tests__')) out.push(path);
  }
  return out;
}

const PRODUCTION_SOURCES = [
  ...sourceFiles(join(REPO, 'apps')),
  ...sourceFiles(join(REPO, 'packages/lib/src')),
].map((path) => ({ path: relative(REPO, path), text: readFileSync(path, 'utf8') }));

/** Files that name `symbol` in an import from a module path matching `from`. */
function importersOf(symbol: string, from: RegExp): string[] {
  return PRODUCTION_SOURCES.filter(({ text }) => {
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
      if (from.test(m[2]) && m[1].split(',').some((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] === symbol)) return true;
    }
    return false;
  }).map(({ path }) => path).sort();
}

describe('SEC-2 (partial) SEC-3 (partial) the org sign-in seam is structural (D-OW-45)', () => {
  it('SEC-2 (partial) every caller-access function in the permissions layer takes an AccessActor first', () => {
    expectTypeOf<Parameters<typeof permissions.getUserAccessLevel>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.canUserViewPage>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.canUserEditPage>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.canUserSharePage>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.canUserDeletePage>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.isDriveOwnerOrAdmin>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.isUserDriveMember>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getUserAccessiblePagesInDrive>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getUserAccessiblePagesInDriveWithDetails>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getUserDriveAccess>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getUserDrivePermissions>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getBatchPagePermissions>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof permissions.getDriveIdsForUser>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof appPermissions.getAppAccessLevel>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof appPermissions.getScopedAccessLevel>[1]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof memberDrives.listMemberDrives>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof memberDrives.getMemberDriveIds>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof relationships.loadDriveRelationship>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof relationships.loadDriveLeadAuthority>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof accessibleIds.accessiblePageIds>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof driveService.listAccessibleDrives>[0]>().toEqualTypeOf<AccessActor>();
    expectTypeOf<Parameters<typeof driveService.getDriveAccess>[1]>().toEqualTypeOf<AccessActor>();
  });

  it('SEC-2 (partial) the userId-only page-visibility SQL source is not a package export and is read only behind the actor gate', () => {
    expect(Object.keys(LIB_PACKAGE.exports)).not.toContain('./permissions/accessible-page-ids-source');
    expect(Object.keys(LIB_PACKAGE.exports)).not.toContain('./organizations/authentication-policy');
    expect(importersOf('accessiblePageIdsSource', /accessible-page-ids-source$/)).toEqual([
      'packages/lib/src/permissions/accessible-page-ids.ts',
      'packages/lib/src/services/page-payload-service.ts',
    ]);
  });

  it('SEC-2 (partial) third-party membership facts are asked only where no credential is opening content', () => {
    // Billing standing and donations (what someone may fund or be billed for): out of the content seam by design.
    expect(importersOf('holdsDriveAccess', /permissions\/permissions$|\.\/permissions$/)).toEqual([
      'packages/lib/src/billing/wallet-funding-shell.ts',
      'packages/lib/src/services/drive-agent-service.ts',
      'packages/lib/src/services/drive-wallet-service.ts',
    ]);
    expect(importersOf('listDriveIdsHeldBy', /permissions\/permissions$/)).toEqual([
      'packages/lib/src/services/drive-wallet-service.ts',
    ]);
    // Wallet standing, and whether the TARGET of a drive transfer (not the caller) is a member of it.
    expect(importersOf('loadUserDriveRelationships', /drive-relationship-loader$/)).toEqual([
      'apps/web/src/app/api/account/handle-drive/route.ts',
      'packages/lib/src/permissions/spend-standing.ts',
    ]);
    // An admin viewing the grants a member holds: a fact about the member, not the admin opening content.
    expect(importersOf('getGrantedAccessLevel', /permissions\/permissions$/)).toEqual([
      'apps/web/src/app/api/drives/[driveId]/permissions-tree/route.ts',
    ]);
  });
});
