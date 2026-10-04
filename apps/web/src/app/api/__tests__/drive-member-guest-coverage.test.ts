/**
 * Drive Member GUEST decision — Query Coverage
 *
 * A GUEST drive_members row (a redeemed page share link, 0308) is accepted but
 * is NOT a drive membership: a guest holds exactly its page_permissions grants
 * and nothing the drive hands its members. Every pre-existing reader of
 * drive_members was written when "an accepted row" meant "a member", so each one
 * had to be re-decided rather than assumed safe — a new row shape changes what
 * old code means without changing a line of it.
 *
 * This ledger records that decision per file, with the EXACT number of
 * drive_members reads in it. A new file that reads drive_members, or a new read
 * in a ledgered file, changes the count and fails here until someone decides
 * what a GUEST means at that read and writes it down.
 *
 *   excludes — the file treats a GUEST row as absent (isGuestRole / role <> 'GUEST').
 *   upgrades — the file turns a GUEST row into a real membership (invites, drive links).
 *   neutral  — a GUEST row cannot gain anything at these reads; the reason says why.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps', 'web', 'src', 'app'),
  join(REPO_ROOT, 'apps', 'web', 'src', 'lib'),
  join(REPO_ROOT, 'apps', 'web', 'src', 'services'),
  join(REPO_ROOT, 'apps', 'realtime', 'src'),
  join(REPO_ROOT, 'apps', 'processor', 'src'),
  join(REPO_ROOT, 'packages', 'lib', 'src'),
];

const ORM_READ_SITE = /(?:\.from|\.(?:left|inner|right|full)Join)\(\s*driveMembers\b|\bquery\.driveMembers\.find(?:First|Many)\(/g;
const SQL_READ_SITE = /\b(?:JOIN|FROM)\s+drive_members\b/g;
const GUEST_MENTION = /isGuestRole\(|'GUEST'/;

type Decision = 'excludes' | 'upgrades' | 'neutral';
type Entry = { reads: number; decision: Decision; reason: string };

const LEDGER = new Map<string, Entry>([
  // ── packages/lib/src ────────────────────────────────────────────────────
  ['packages/lib/src/permissions/permissions.ts', {
    reads: 15, decision: 'excludes',
    reason: 'Every "is a member" door: rule 4, custom roles, drive-root access, isUserDriveMember, getUserDriveAccess (guest keeps access only through a live page grant), getUserDrivePermissions (null), usersShareDrive, getDriveIdsForUser, both accessible-pages listings and resolvePagePermissionRow (batch + page viewers).',
  }],
  ['packages/lib/src/permissions/membership-queries.ts', {
    reads: 1, decision: 'excludes',
    reason: 'getMemberCustomRoleId returns null for a guest: a guest carries no custom role.',
  }],
  ['packages/lib/src/permissions/permission-mutations.ts', {
    reads: 2, decision: 'excludes',
    reason: 'A guest who created a page may not share it by virtue of membership; its share right comes from its grant. The second read is ADMIN-only.',
  }],
  ['packages/lib/src/services/drive-member-service.ts', {
    reads: 9, decision: 'excludes',
    reason: 'checkDriveAccess, member id lists, broadcast recipients, custom-role holders, the Members listing, isMemberOfDrive and member detail all leave guests out. Standard-role lookup filters by role already; updateMemberRole is a writer.',
  }],
  ['packages/lib/src/services/drive-service.ts', {
    reads: 3, decision: 'excludes',
    reason: 'listAccessibleDrives reaches a guest drive only as a page collaborator (not token-scopable, no drive-wide create); getDriveAccess/getDriveAccessWithDrive report no membership. updateDriveLastAccessed is a write, not a read.',
  }],
  ['packages/lib/src/services/app-shell-service.ts', {
    reads: 3, decision: 'excludes',
    reason: 'A guest drive is not promoted into the shell (its metadata and roster would leak), and guests are left off every roster sent to members. The per-caller role read is scoped to the already-filtered drive set.',
  }],
  ['packages/lib/src/services/drive-agent-service.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A guest may not bind an agent to the drive at any role — an agent MEMBER reads the whole drive.',
  }],
  ['packages/lib/src/services/drive-role-service.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A guest is not a member for the roles pages.',
  }],
  ['packages/lib/src/services/calendar-event-drive-service.ts', {
    reads: 2, decision: 'excludes',
    reason: 'A guest of a drive an event is shared into is neither an event-drive member nor an attendee candidate.',
  }],
  ['packages/lib/src/services/agent-workspaces/agent-workspace-tenant.ts', {
    reads: 1, decision: 'excludes',
    reason: "resolveDriveMembership answers 'none' for a guest: no agent-workspace, sandbox or preview access.",
  }],
  ['packages/lib/src/repositories/account-repository.ts', {
    reads: 2, decision: 'excludes',
    reason: 'Account deletion does not count guests, so a drive shared only with guests is solo.',
  }],
  ['packages/lib/src/compliance/export/gdpr-export.ts', {
    reads: 1, decision: 'excludes',
    reason: "A guest drive is not one of the subject's drives: every listed drive has ALL its pages exported.",
  }],
  ['packages/lib/src/agent-accounts/account-facts-repository.ts', {
    reads: 1, decision: 'neutral',
    reason: 'The only direct read is ADMIN-only (consenters); driveRole goes through getDriveAccess, which excludes guests.',
  }],
  // ── apps/web/src/app ────────────────────────────────────────────────────
  ['apps/web/src/app/api/drives/[driveId]/pages/route.ts', {
    reads: 2, decision: 'excludes',
    reason: 'getPermittedPages is its own copy of rule 4; a guest gets only its explicit grants. The second read is ADMIN-only.',
  }],
  ['apps/web/src/app/api/drives/[driveId]/assignees/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'Guests are not assignable members of the drive.',
  }],
  ['apps/web/src/app/api/activity/summary/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A guest drive does not feed the "pages updated" count.',
  }],
  ['apps/web/src/app/api/pulse/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A guest drive is not one of the drives pulse summarises.',
  }],
  ['apps/web/src/app/api/pulse/generate/route.ts', {
    reads: 2, decision: 'excludes',
    reason: 'A guest drive is not summarised, and the co-member roster sent to the model neither includes guests nor is built from a guest drive.',
  }],
  ['apps/web/src/app/api/pulse/cron/route.ts', {
    reads: 2, decision: 'excludes',
    reason: 'Same two reads as pulse/generate.',
  }],
  ['apps/web/src/app/api/ai/page-agents/multi-drive/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'resolveEditableDriveIds admits only ADMIN and MEMBER rows; a GUEST row is not editable.',
  }],
  ['apps/web/src/app/api/users/messageable/route.ts', {
    reads: 2, decision: 'excludes',
    reason: "A guest does not see the drive's people as messageable, and they do not see the guest.",
  }],
  ['apps/web/src/app/api/commands/route.ts', {
    reads: 1, decision: 'excludes',
    reason: "A guest drive's commands are not the guest's commands.",
  }],
  ['apps/web/src/app/api/account/drives-status/route.ts', {
    reads: 2, decision: 'excludes',
    reason: 'The member count matches accountRepository (guests excluded); the transfer-target read is ADMIN-only.',
  }],
  ['apps/web/src/app/api/pages/bulk-copy/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Writing into the target drive needs an OWNER/ADMIN role on the row; GUEST is neither.',
  }],
  ['apps/web/src/app/api/pages/bulk-move/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Writing into the target drive needs an OWNER/ADMIN role on the row; GUEST is neither.',
  }],
  ['apps/web/src/app/api/pages/tree/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'The gate admits a guest on purpose; the tree is then cut to getUserAccessiblePagesInDrive, which yields only its explicit grants.',
  }],
  ['apps/web/src/app/api/sidebar/badges/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Candidate filter; getBatchPagePermissions decides, and it excludes guests.',
  }],
  ['apps/web/src/app/api/messages/threads/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Candidate filter; getBatchPagePermissions decides, and it excludes guests.',
  }],
  ['apps/web/src/app/api/inbox/route.ts', {
    reads: 2, decision: 'neutral',
    reason: 'Candidate filters; getBatchPagePermissions decides, and it excludes guests.',
  }],
  ['apps/web/src/app/api/channels/[pageId]/messages/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Candidate recipients; getUsersWhoCanViewPage decides, and it excludes guests.',
  }],
  ['apps/web/src/app/api/drives/[driveId]/trash/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'ADMIN-only read.',
  }],
  ['apps/web/src/app/api/drives/[driveId]/permissions-tree/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'ADMIN-only read.',
  }],
  ['apps/web/src/app/api/account/handle-drive/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Transfer target must be an accepted ADMIN.',
  }],
  ['apps/web/src/app/api/pages/[pageId]/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Selects non-OWNER/ADMIN rows to kick when a page goes private; kicking a guest without a grant is correct.',
  }],
  ['apps/web/src/app/api/drives/[driveId]/backups/[backupId]/restore/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Restore replaces every row; a snapshotted guest is restored as a guest.',
  }],
  ['apps/web/src/app/api/admin/global-prompt/route.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Platform-admin debug picker; grants nothing.',
  }],
  // ── apps/web/src/lib ────────────────────────────────────────────────────
  ['apps/web/src/lib/users/visibility.ts', {
    reads: 3, decision: 'excludes',
    reason: 'A guest row opens no shared context: no profile lookup or name search across it, in either direction.',
  }],
  ['apps/web/src/lib/memory/discovery-service.ts', {
    reads: 2, decision: 'excludes',
    reason: 'Memory discovery does not mine a guest drive\'s conversations or activity.',
  }],
  ['apps/web/src/lib/ai/tools/activity-tools.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A guest drive is not one of the drives the activity tool reads.',
  }],
  ['apps/web/src/lib/ai/tools/command-tools.ts', {
    reads: 1, decision: 'excludes',
    reason: "A guest drive's commands are not the guest's commands.",
  }],
  ['apps/web/src/lib/ai/tools/channel-tools.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Candidate recipients; each is checked with canUserViewPage, which excludes guests.',
  }],
  ['apps/web/src/lib/repositories/drive-invite-repository.ts', {
    reads: 3, decision: 'upgrades',
    reason: 'Accepting a drive invite upgrades a GUEST row in place (setWhere role = GUEST); any other existing row stays ALREADY_MEMBER.',
  }],
  ['apps/web/src/lib/repositories/page-invite-repository.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Page-invite acceptance leaves an existing row as it is when accepted. OPEN DECISION (PR body): it still CREATES a MEMBER row for a newcomer and promotes a pending row.',
  }],
  ['apps/web/src/lib/auth/revoke-adapters.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Returns the raw role; validateRevokeRequest admits only OWNER/ADMIN.',
  }],
  // ── apps/web/src/services ───────────────────────────────────────────────
  ['apps/web/src/services/api/drive-backup-service.ts', {
    reads: 2, decision: 'neutral',
    reason: 'Snapshot copies every row faithfully (a guest stays a guest); the other read is ADMIN-only.',
  }],
  ['apps/web/src/services/api/rollback/preview.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Displays the target row\'s current values; the caller is authorized separately.',
  }],
  ['apps/web/src/services/api/rollback/rollback-executors.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Collects holders of a deleted custom role to revalidate them; a guest carries no usable custom role.',
  }],
  ['apps/web/src/services/api/rollback/redo-executors.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Collects holders of a deleted custom role to revalidate them; a guest carries no usable custom role.',
  }],
]);

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__' || entry === 'dist') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

const toRepoPath = (absolutePath: string) => absolutePath.replace(REPO_ROOT + '/', '');

function readCounts(): Map<string, { reads: number; source: string }> {
  const counts = new Map<string, { reads: number; source: string }>();
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      const reads = [...source.matchAll(ORM_READ_SITE)].length + [...source.matchAll(SQL_READ_SITE)].length;
      if (reads > 0) counts.set(toRepoPath(file), { reads, source });
    }
  }
  return counts;
}

describe('Drive Member GUEST decision coverage', () => {
  const counts = readCounts();

  it('scans a real tree (guards against a vacuous pass from a wrong REPO_ROOT)', () => {
    expect(counts.size).toBeGreaterThan(20);
  });

  it('every file that reads drive_members has a recorded GUEST decision for exactly its reads', () => {
    const undecided = [...counts.entries()]
      .filter(([path, { reads }]) => LEDGER.get(path)?.reads !== reads)
      .map(([path, { reads }]) => `${path}: ${reads} read(s), ledger says ${LEDGER.get(path)?.reads ?? 'nothing'}`);
    expect(undecided).toEqual([]);
  });

  it('every ledger entry still names a file that reads drive_members', () => {
    const stale = [...LEDGER.keys()].filter((path) => !counts.has(path));
    expect(stale).toEqual([]);
  });

  it('every file recorded as excluding or upgrading guests actually handles the GUEST role', () => {
    const unhandled = [...LEDGER.entries()]
      .filter(([, entry]) => entry.decision !== 'neutral')
      .filter(([path]) => !GUEST_MENTION.test(counts.get(path)?.source ?? ''))
      .map(([path]) => path);
    expect(unhandled).toEqual([]);
  });
});
