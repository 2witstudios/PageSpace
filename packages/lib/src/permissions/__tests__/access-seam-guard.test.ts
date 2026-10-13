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

  it('SEC-2 (partial) every automation actor is pinned with its reason, and only output filtered per reader reaches past one drive (D-OW-62)', () => {
    const callers = (pattern: RegExp) =>
      PRODUCTION_SOURCES.filter(({ path, text }) => pattern.test(text) && !path.endsWith('permissions/access-actor.ts')).map(({ path }) => path).sort();
    // Each is work no one signs in for (D-OW-34). Request-driven paths (a channel @mention, a manual workflow Run)
    // run as the request's credential instead, never as an automation.
    const CONFINED_TO_THEIR_DRIVE: Record<string, string> = {
      'apps/web/src/app/api/cron/scheduled-backups/route.ts': 'a backup schedule, confined to the drive it backs up',
      'apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts': 'session-end teardown binds nothing: reaches no drive',
      'apps/web/src/lib/auth/google-avatar.ts': 'avatar import during sign-in: the user\'s own avatar, reaches no drive',
      'apps/web/src/lib/canvas/publish-page.ts': 'published-site regeneration, confined to the published drive',
      'apps/web/src/lib/integrations/zoom/process-webhook.ts': 'a Zoom recording filed into the connection\'s target drive',
      'apps/web/src/lib/integrations/zoom/webhook-trigger-executor.ts': 'a Zoom trigger, confined to the workflow\'s drive',
      'apps/web/src/lib/webhooks/page-webhook-trigger-executor.ts': 'a page webhook trigger, confined to the workflow\'s drive',
      'apps/web/src/lib/workflows/calendar-trigger-executor.ts': 'a calendar trigger, confined to the trigger\'s drive',
      'apps/web/src/lib/workflows/workflow-executor.ts': 'a scheduled or triggered run, confined to the workflow\'s (and its agent\'s) drive',
    };
    const OVER_HELD_DRIVES: Record<string, string> = {
      'apps/web/src/app/api/drives/locked/route.ts': 'names only of the person\'s own drives, to show which are locked',
      'apps/web/src/app/api/pulse/cron/route.ts': 'Pulse: the summary records its orgs and is omitted for a reader any of them refuses',
      'apps/web/src/lib/memory/discovery-service.ts': 'memory: distilled items record their orgs and are omitted for a reader any of them refuses',
    };
    expect(callers(/\bautomationActor\(/)).toEqual(Object.keys({ ...CONFINED_TO_THEIR_DRIVE, ...OVER_HELD_DRIVES }).sort());
    expect(callers(/\bHELD_DRIVES\b/)).toEqual(Object.keys(OVER_HELD_DRIVES).sort());
  });

  it('SEC-2 (partial) third-party membership facts are asked only where no credential is opening content', () => {
    // The donor re-check inside a donation's transaction (the wallet route already passed the actor gate), and
    // recapping what someone granted an agent. Wallet reads and spends themselves go through the actor (D-OW-45).
    expect(importersOf('holdsDriveAccess', /permissions\/permissions$|\.\/permissions$/)).toEqual([
      'packages/lib/src/billing/wallet-funding-shell.ts',
      'packages/lib/src/services/drive-agent-service.ts',
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
