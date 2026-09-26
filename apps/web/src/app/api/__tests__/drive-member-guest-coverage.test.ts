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
 *   excludes — the file treats a GUEST row as absent (isGuestRole / role <> 'GUEST', or the one
 *              role map on the org-wallets branch: driveMembershipRole / driveMembershipRow).
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
// A file handles GUEST when it names it, or reads rows through the one role map
// (permissions/drive-member-role.ts), which classifies GUEST as no membership.
const GUEST_MENTION = /isGuestRole\(|holdsAcceptedGuestRow\(|'GUEST'|driveMembershipRole\(|driveMembershipRow\(|DRIVE_MEMBERSHIP_ROLES/;

type Decision = 'excludes' | 'upgrades' | 'neutral';
type Entry = { reads: number; decision: Decision; reason: string };

const LEDGER = new Map<string, Entry>([
  // ── packages/lib/src ────────────────────────────────────────────────────
  ['packages/lib/src/permissions/permissions.ts', {
    reads: 6, decision: 'excludes',
    reason: 'getDriveIdsForUser (a GUEST row reaches the drive only through its page grants) in both its dark and org-aware forms (the latter through driveMembershipRow), both usersShareDrive reads, and the batch page-permission and page-viewer joins, which resolvePagePermissionRow decides (no custom role, no rule 4 for a GUEST) after withEffectiveMembership re-reads each row through driveMembershipRow. Every other door (rule 4, custom roles, drive-root access, isUserDriveMember, getUserDriveAccess, getUserDrivePermissions, both accessible-pages listings) goes through loadEffectiveDriveMembership, which reads a GUEST row as none.',
  }],
  ['packages/lib/src/permissions/membership-queries.ts', {
    reads: 2, decision: 'excludes',
    reason: 'getMemberCustomRoleId returns null for a guest (a guest carries no custom role); holdsAcceptedGuestRow is the one read that asks for the GUEST row itself, for the callers that also admit page collaborators (the page-tree gate, the agent-binding granter).',
  }],
  ['packages/lib/src/services/drive-member-service.ts', {
    reads: 3, decision: 'excludes',
    reason: 'The Members listing and member detail leave guests out; updateMemberRole is a writer. checkDriveAccess, member id lists, broadcast recipients, custom-role holders and isMemberOfDrive go through loadEffectiveDriveMembership / listDriveAudience, which read a GUEST row as none.',
  }],
  ['packages/lib/src/services/drive-service.ts', {
    reads: 2, decision: 'excludes',
    reason: 'listAccessibleDrives reaches a guest drive only as a page collaborator (not token-scopable, no drive-wide create): the dark form filters GUEST, the org-aware form reads each row through driveMembershipRow. getDriveAccess/getDriveAccessWithDrive go through loadEffectiveDriveMembership.',
  }],
  ['packages/lib/src/services/app-shell-service.ts', {
    reads: 2, decision: 'excludes',
    reason: 'Guests are left off every roster sent to members. The per-caller lastAccessedAt read is display-only and scoped to the drive set listMemberDrives already decided (which reads a GUEST row as no membership).',
  }],
  ['packages/lib/src/repositories/account-repository.ts', {
    reads: 2, decision: 'excludes',
    reason: 'Account deletion does not count guests, so a drive shared only with guests is solo.',
  }],
  ['packages/lib/src/compliance/export/gdpr-export.ts', {
    reads: 1, decision: 'excludes',
    reason: "A guest drive is not one of the subject's drives: every listed drive has ALL its pages exported.",
  }],
  // ── the org-wallets resolver layer (the one role map) ─────────────────────
  ['packages/lib/src/permissions/org-drive-membership.ts', {
    reads: 5, decision: 'excludes',
    reason: 'Every read goes through driveMembershipRow / driveMembershipRole (drive-member-role.ts), which classifies GUEST as no membership: the effective membership, explicit-scope authority, accepted rows for the relationship and spend-standing loaders, org-deletion member pairs, and the join-request row state.',
  }],
  ['packages/lib/src/permissions/member-drives.ts', {
    reads: 4, decision: 'excludes',
    reason: 'listMemberDrives, getAdministeredDriveIds and memberOfAnyDriveCondition read rows through driveMembershipRole or restrict to DRIVE_MEMBERSHIP_ROLES, so a GUEST drive is no member drive (commands, activity, discovery, pulse, visibility all use it).',
  }],
  ['packages/lib/src/permissions/drive-audience.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A drive\'s audience (recipients, member ids, custom-role holders, isMemberOfDrive) reads each row through driveMembershipRow: a GUEST is never in it.',
  }],
  ['packages/lib/src/permissions/org-drive-directory.ts', {
    reads: 1, decision: 'excludes',
    reason: 'The org Drives directory reads each row through driveMembershipRole: a GUEST drive is not joined and stays requestable.',
  }],
  ['packages/lib/src/permissions/drive-join-request-closure.ts', {
    reads: 1, decision: 'excludes',
    reason: 'A requester holding a GUEST row is still a requester (driveMembershipRole): the row does not close their join request as already-a-member.',
  }],
  ['packages/lib/src/services/org-membership-sync.ts', {
    reads: 1, decision: 'upgrades',
    reason: 'The org sync reads rows through driveMembershipRole; admitting an org member who holds only a GUEST row upgrades that row in place, and a GUEST row is otherwise left alone.',
  }],
  // ── apps/web/src/app ────────────────────────────────────────────────────
  ['apps/web/src/app/api/drives/[driveId]/assignees/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'Guests are not assignable members of the drive.',
  }],
  ['apps/web/src/app/api/pulse/generate/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'The co-member roster sent to the model leaves guests out. The drive set itself is getMemberDriveIds (a GUEST row is no membership).',
  }],
  ['apps/web/src/app/api/pulse/cron/route.ts', {
    reads: 1, decision: 'excludes',
    reason: 'Same roster read as pulse/generate.',
  }],
  ['apps/web/src/app/api/users/messageable/route.ts', {
    reads: 2, decision: 'excludes',
    reason: "A guest does not see the drive's people as messageable, and they do not see the guest.",
  }],
  ['apps/web/src/app/api/account/drives-status/route.ts', {
    reads: 2, decision: 'excludes',
    reason: 'The member count matches accountRepository (guests excluded); the transfer-target read is ADMIN-only.',
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
  ['apps/web/src/lib/repositories/drive-invite-repository.ts', {
    reads: 2, decision: 'upgrades',
    reason: 'Accepting a drive invite upgrades a GUEST row in place (setWhere role = GUEST, an insert, not a counted read); any other existing row stays ALREADY_MEMBER. findExistingMember returns the raw row with its role for the pipe to decide; the pending-by-email read matches unaccepted rows only.',
  }],
  ['apps/web/src/lib/repositories/page-invite-repository.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Page-invite acceptance leaves an existing row as it is when accepted. OPEN DECISION (PR body): it still CREATES a MEMBER row for a newcomer and promotes a pending row.',
  }],
  // ── apps/web/src/services ───────────────────────────────────────────────
  ['apps/web/src/services/api/drive-backup-service.ts', {
    reads: 1, decision: 'neutral',
    reason: 'Snapshot copies every row faithfully (a guest stays a guest).',
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
