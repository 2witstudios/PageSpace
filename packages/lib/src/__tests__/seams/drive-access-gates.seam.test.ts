/**
 * Seam guard 4 — no inline drive access gates.
 *
 * Who may open a drive, and who counts as its member, is decided in packages/lib/src/permissions
 * and nowhere else (CLAUDE.md; leaf B7c). Before B7c about twenty gates in apps/web answered it
 * with their own drives.ownerId comparison and drive_members read: they refused org power, missed
 * implicit Open members, and honoured a stale source='org' row, so they disagreed with every lib
 * resolver. They now ask isDriveLead, loadDriveRelationship(s), listMemberDrives /
 * getMemberDriveIds / memberOfAnyDriveCondition, or listDriveAudience(s).
 *
 * This guard finds every query of drive_members and every comparison with an ownerId outside
 * packages/lib/src/permissions, attributes each to the function that holds it, and requires each
 * function to match its allowlist entry EXACTLY (count per kind), with a reason why those sites
 * are not an access decision: a writer, invite management, a payer lookup, an inventory of the
 * caller's own drives, a display list behind an access check, or an ownerId that is not a drive's.
 * A new query beside an allowlisted one changes that function's count; one anywhere else has no
 * entry. Validation is per site, never per file.
 */
import { describe, expect, it } from 'vitest';
import { listSourceFiles } from './walk';
import { checkSites, scanFile, scanSource, type AccessGateAllowlist } from './access-gate-scan';

/** The canonical home of drive access decisions. */
const EXEMPT = ['packages/lib/src/permissions/'];

/** The schema itself and the e2e harness that seeds rows directly: not application read paths. */
const NOT_APPLICATION_CODE = ['packages/db/', 'apps/e2e/'];

const OWN_LEAD_INVENTORY =
  "an inventory of drives the caller LEADS (drives.ownerId = caller): it lists the caller's own drives and grants nothing beyond them";
const PAYER =
  "payer lookup: joins the drive lead's user row for the subscription tier that bills the drive (WAL-9 territory), not an access decision";
const MEMBER_ADMIN_DISPLAY =
  'member management display behind the checkDriveAccess owner/admin gate: lists rows including pending invitations ("Invitation pending"); grants nothing';
const ROLE_HOLDERS =
  'collects every holder of a role being deleted so each can be revalidated; including pending rows is the fail-safe direction (writer, not an access decision)';
const TEAM_ROSTER =
  "team roster for the pulse prompt: names of co-members of the caller's member drives (the drives come from getMemberDriveIds); display, grants nothing";
const NOT_A_DRIVE = (what: string) => `not a drive: ${what}; no drive access is decided here`;

export const DRIVE_ACCESS_GATE_ALLOWLIST: AccessGateAllowlist = {
  // ── apps/web: routes ────────────────────────────────────────────────────
  'apps/web/src/app/api/account/drives-status/route.ts': {
    GET: {
      ownerCompares: 1,
      reads: 2,
      reason: `account-deletion UI: ${OWN_LEAD_INVENTORY}; counts each led drive's rows to warn about other members and lists its admins as transfer candidates (display; handle-drive re-checks the target through loadDriveRelationship)`,
    },
  },
  'apps/web/src/app/api/admin/global-prompt/route.ts': {
    handleGlobalPrompt: {
      ownerCompares: 1,
      reads: 1,
      reason: "platform-admin debug tool (admin role gate) that already reads any drive's pages; its drive picker lists the admin's own drives and rows and grants nothing",
    },
  },
  'apps/web/src/app/api/ai/conversations/[conversationId]/plan/route.ts': {
    DELETE: { ownerCompares: 1, reason: NOT_A_DRIVE("row.ownerId is the AI conversation's userId") },
  },
  'apps/web/src/app/api/app-hosting/apps/[appId]/dedicated/route.ts': {
    authorize: {
      ownerCompares: 1,
      reason: "payer gate: dedicated app hosting is bought by the drive's payer (lookupDriveOwnerId, the lead today); who pays for an org drive is the WAL-9 lane's, not an access decision",
    },
  },
  'apps/web/src/app/api/cron/scheduled-backups/route.ts': {
    GET: { ownerCompares: 1, reason: PAYER },
  },
  'apps/web/src/app/api/drives/[driveId]/assignees/route.ts': {
    GET: {
      reads: 1,
      reason: "task assignee picker: enumerates the drive's accepted rows after the route's getUserDriveAccess check; a display list that grants nothing",
    },
  },
  'apps/web/src/app/api/drives/[driveId]/backups/[backupId]/restore/route.ts': {
    POST: {
      reads: 1,
      reason: "backup restore replaces every drive_members row (pending included) with the snapshot's: a writer's full-replacement read behind the route's owner/admin gate",
    },
  },
  'apps/web/src/app/api/drives/[driveId]/backups/schedule/route.ts': {
    GET: { ownerCompares: 1, reason: PAYER },
    PATCH: { ownerCompares: 1, reason: PAYER },
  },
  'apps/web/src/app/api/drives/[driveId]/domains/route.ts': {
    getMaxCustomDomainsForDrive: { ownerCompares: 1, reason: PAYER },
  },
  'apps/web/src/app/api/drives/[driveId]/subdomain/route.ts': {
    canChooseSubdomain: { ownerCompares: 1, reason: PAYER },
  },
  'apps/web/src/app/api/env-bridge/ws/route.ts': {
    UPGRADE: { ownerCompares: 1, reason: NOT_A_DRIVE('row.ownerId is the local environment enrollment owner') },
  },
  'apps/web/src/app/api/pulse/cron/route.ts': {
    buildAndPersistPulse: { reads: 1, reason: TEAM_ROSTER },
  },
  'apps/web/src/app/api/pulse/generate/route.ts': {
    POST: { reads: 1, reason: TEAM_ROSTER },
  },
  'apps/web/src/app/api/search/route.ts': {
    GET: {
      ownerCompares: 2,
      reason: `search drive results and the page corpus are scoped to ${OWN_LEAD_INVENTORY}; narrower than access`,
    },
  },
  'apps/web/src/app/api/storage/info/route.ts': {
    GET: {
      ownerCompares: 2,
      reason: `storage breakdown: ${OWN_LEAD_INVENTORY}, plus drives the caller's files live in, each non-led one re-checked with getUserDriveAccess (quota display)`,
    },
  },
  'apps/web/src/app/api/users/messageable/route.ts': {
    GET: {
      ownerCompares: 2,
      reads: 2,
      reason: 'DM eligibility (whom the caller may start a DM with) deliberately skips the acceptedAt gate, as documented in the route and in usersShareDrive; it opens no drive or page',
    },
  },
  // ── apps/web: client components (the API enforces) ──────────────────────
  'apps/web/src/app/dashboard/[driveId]/members/[userId]/page.tsx': {
    MemberSettingsPage: { ownerCompares: 4, reason: "client display: hides role controls on the drive lead's own member row; the member routes enforce" },
  },
  'apps/web/src/app/dashboard/trash/page.tsx': {
    GlobalTrashPage: { ownerCompares: 1, reason: 'client display filter over the drives the API already returned to this user' },
  },
  'apps/web/src/components/shared/PageWebhooksDialog.tsx': {
    PageWebhooksDialogImpl: { ownerCompares: 2, reason: NOT_A_DRIVE('revealed.ownerId is the owner of a revealed webhook secret (client state)') },
  },
  'apps/web/src/hooks/usePermissions.ts': {
    usePermissions: { ownerCompares: 1, reason: "client display flag (isOwner) for UI affordances; every write it gates is enforced by the API" },
  },
  // ── apps/web: lib and services ───────────────────────────────────────────
  'apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts': {
    endSession: { ownerCompares: 1, reason: NOT_A_DRIVE('ownerId is an optional agent-workspace owner filter compared with undefined') },
  },
  'apps/web/src/lib/ai/core/materialize-interrupted-stream.ts': {
    materializeInterruptedStream: { ownerCompares: 1, reason: NOT_A_DRIVE('globalOwnerId is a global conversation owner compared with null') },
  },
  'apps/web/src/lib/ai/core/stream-subscription-authz.ts': {
    canSubscribeToStream: { ownerCompares: 1, reason: NOT_A_DRIVE("streamOwnerId is an AI stream's owner") },
  },
  'apps/web/src/lib/ai/tools/member-tools.ts': {
    execute: { ownerCompares: 2, reason: "joins the drive lead's user and profile rows to show the owner in the member list, after checkDriveAccess; display" },
  },
  'apps/web/src/lib/ai/tools/session-tools-runtime.ts': {
    listSharedWorkspaces: { ownerCompares: 1, reason: NOT_A_DRIVE("session.ownerId is an agent session's owner") },
    killWorker: { ownerCompares: 1, reason: NOT_A_DRIVE("streamOwnerId is a worker stream's owner") },
    resolveCallerSessionForWorker: { ownerCompares: 1, reason: NOT_A_DRIVE("ownerId is an agent conversation's owner") },
  },
  'apps/web/src/lib/ai/tools/session-tools.ts': {
    execute: { ownerCompares: 1, reason: NOT_A_DRIVE("opened.row.ownerId is an agent session's owner") },
    openAddressableSession: { ownerCompares: 1, reason: NOT_A_DRIVE("row.ownerId is an agent session's owner") },
  },
  'apps/web/src/lib/memory/integration-service.ts': {
    updatePersonalizationPage: { ownerCompares: 1, reason: "scopes the memory write to the caller's own HOME drive (kind HOME, never an org drive)" },
  },
  'apps/web/src/lib/auth/session-retirement.ts': {
    retireReplacedSession: { ownerCompares: 1, reason: NOT_A_DRIVE("ownerId is an auth session's user") },
  },
  'apps/web/src/lib/dev-preview/manage-decision.ts': {
    decideDevPreviewManage: { ownerCompares: 2, reason: NOT_A_DRIVE("sessionOwnerId is a dev-preview session's owner (drive authority goes through isDriveOwnerOrAdmin)") },
  },
  'apps/web/src/lib/repositories/drive-invite-repository.ts': {
    findExistingMember: { reads: 1, reason: 'invite management: looks up a row by (drive, user) to avoid a duplicate invitation' },
    findActivePendingMemberByEmail: { reads: 1, reason: 'invite management: filters acceptedAt IS NULL on purpose, to list pending invitations' },
  },
  'apps/web/src/lib/repositories/page-invite-repository.ts': {
    consumeInviteAndGrantPage: { reads: 1, reason: 'page-invite acceptance reads the (drive, user) row to write it: it inserts a missing row or stamps acceptedAt on a pending one' },
  },
  'apps/web/src/services/api/drive-backup-service.ts': {
    createDriveBackup: { reads: 1, reason: 'the backup snapshot copies every drive_members row, pending included, so a restore reproduces the drive faithfully' },
  },
  'apps/web/src/services/api/rollback/preview.ts': {
    basePreview: { reads: 1, reason: "conflict preview shows the target member row's current values before a rollback; the caller is authorized separately" },
  },
  'apps/web/src/services/api/rollback/redo-executors.ts': {
    redoRoleChange: { reads: 1, reason: ROLE_HOLDERS },
  },
  'apps/web/src/services/api/rollback/rollback-executors.ts': {
    rollbackRoleChange: { reads: 1, reason: ROLE_HOLDERS },
  },
  // ── packages/lib outside permissions ─────────────────────────────────────
  'packages/lib/src/agent-workspaces/decide-workspace-access.ts': {
    decideAgentSessionAccess: { ownerCompares: 1, reason: NOT_A_DRIVE("session.ownerId is an agent session's owner") },
    decideAgentSessionEndAccess: { ownerCompares: 1, reason: NOT_A_DRIVE("session.ownerId is an agent session's owner") },
    decideAgentSessionRenameAccess: { ownerCompares: 1, reason: NOT_A_DRIVE("session.ownerId is an agent session's owner") },
  },
  'packages/lib/src/agent-workspaces/redact-conversation-listing.ts': {
    isConversationVisibleToViewer: { ownerCompares: 2, reason: NOT_A_DRIVE("workspaceOwnerId and conversation.ownerId are an agent workspace's and a conversation thread's owners") },
  },
  'packages/lib/src/compliance/export/gdpr-export.ts': {
    collectUserDrives: { ownerCompares: 1, reads: 1, reason: "GDPR subject-access export of the subject's OWN drives and membership rows; pending invitations are the subject's personal data" },
  },
  'packages/lib/src/onboarding/home-drive.ts': {
    provisionHomeDriveIfNeeded: { ownerCompares: 1, reason: "provisioning looks up the user's own HOME drive (never an org drive)" },
  },
  'packages/lib/src/env-bridge/decide-bind.ts': {
    policyAllows: { ownerCompares: 1, reason: NOT_A_DRIVE("ownerId is a local environment's owner") },
  },
  'packages/lib/src/organizations/deletion.ts': {
    refuse: { ownerCompares: 1, reason: NOT_A_DRIVE("ownerId is the organization's Owner (org deletion, ORG-6)") },
  },
  'packages/lib/src/organizations/membership.ts': {
    decideOwnershipTransfer: { ownerCompares: 2, reason: NOT_A_DRIVE("currentOwnerId is the organization's Owner (org ownership transfer, ORG-1)") },
  },
  'packages/lib/src/organizations/leave.ts': {
    reassignLedOrgDrives: { ownerCompares: 1, reason: 'writer: selects the org drives a leaving member LEADS so their lead can be reassigned to the org Owner (ORG-6)' },
    planLeadReassignments: { ownerCompares: 1, reason: NOT_A_DRIVE("orgOwnerId is the organization's Owner, excluded as a reassignment source") },
  },
  'packages/lib/src/repositories/account-repository.ts': {
    checkAndDeleteSoloDrives: { ownerCompares: 1, reads: 1, reason: `account deletion: ${OWN_LEAD_INVENTORY} (personal drives only); counting every row, pending included, keeps a drive "multi-member", the conservative direction` },
    getDriveMemberCount: { reads: 1, reason: 'account deletion counts every row of a drive the user leads; counting pending rows makes deletion MORE conservative' },
    getOwnedDrives: { ownerCompares: 1, reason: `account deletion: ${OWN_LEAD_INVENTORY} (personal drives only; org drives are reassigned, O-7)` },
  },
  'packages/lib/src/services/app-shell-service.ts': {
    fetchDriveMembers: { reads: 1, reason: 'member list of the drives the shell already listed through listMemberDrives; returns acceptedAt so the UI can show pending invitations (display)' },
    fetchDriveSummaries: { reads: 1, reason: "display only: the caller's own lastAccessedAt per listed drive; ownership and role come from listMemberDrives" },
  },
  'packages/lib/src/services/agent-workspaces/agent-workspaces-store.ts': {
    list: { ownerCompares: 2, reason: NOT_A_DRIVE('ownerId is an optional agent-workspace owner filter compared with undefined') },
  },
  'packages/lib/src/services/drive-envs/drive-envs-store.ts': {
    countEnvsOwnedBy: { ownerCompares: 1, reason: 'payer quota: counts environments across the drives a payer leads (billing), not an access decision' },
    createIfUnderLimit: { ownerCompares: 1, reason: 'payer quota: counts environments across the drives a payer leads inside the create transaction (billing), not an access decision' },
  },
  'packages/lib/src/services/drive-member-service.ts': {
    getDriveMemberDetails: { reads: 1, reason: MEMBER_ADMIN_DISPLAY },
    listDriveMembers: { reads: 1, reason: MEMBER_ADMIN_DISPLAY },
    updateMemberRole: { reads: 1, reason: 'writer: reads the old role of the row it is about to update, behind the owner/admin gate' },
    getDriveOwnerAsMember: { ownerCompares: 1, reason: "joins the drive lead's user row to show the owner at the top of the member list (display)" },
  },
  'packages/lib/src/services/drive-service.ts': {
    getHomeDrive: { ownerCompares: 1, reason: "looks up the user's own HOME drive (never an org drive)" },
    listAccessibleDrives: {
      ownerCompares: 4,
      reads: 1,
      reason: 'the accessible-drives resolver itself (B7): its dark body is owned drives plus accepted rows; while ORGS_ENABLED it delegates to listAccessibleDrivesWithOrgs',
    },
    listAccessibleDrivesWithOrgs: {
      ownerCompares: 2,
      reads: 1,
      reason: 'the accessible-drives resolver itself (B7): owned drives plus rows and OPEN org drives, each decided by decideListedDriveRole in the permissions layer',
    },
  },
  'packages/lib/src/services/org-membership-sync.ts': {
    loadExistingRows: { reads: 1, reason: "materialization writer (B4): reads the rows the org sync is about to insert, update or delete" },
  },
  'packages/lib/src/services/storage-repository.ts': {
    findUserDriveIds: { ownerCompares: 1, reason: `storage quota: ${OWN_LEAD_INVENTORY} (billing)` },
  },
};

describe('seam: drive access is decided only in packages/lib/src/permissions', () => {
  const files = listSourceFiles(['apps', 'packages']).filter(
    (f) => !NOT_APPLICATION_CODE.some((p) => f.startsWith(p)) && !EXEMPT.some((p) => f.startsWith(p)),
  );
  const result = checkSites(files.flatMap(scanFile), DRIVE_ACCESS_GATE_ALLOWLIST);

  it('every drive_members query and ownerId comparison outside the permissions layer matches its allowlisted function exactly', () => {
    expect(
      result.mismatches,
      'Drive access decided outside packages/lib/src/permissions. Ask isDriveLead, loadDriveRelationship(s), ' +
        'listMemberDrives / getMemberDriveIds, or listDriveAudience(s) instead; only a site that decides no access ' +
        '(a writer, a payer lookup, a display list behind an access check) may be allowlisted, per function, with a reason:\n' +
        result.mismatches.join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry still holds a site (the allowlist only shrinks)', () => {
    expect(result.stale, 'These allowlisted functions no longer hold a site; remove them from DRIVE_ACCESS_GATE_ALLOWLIST').toEqual([]);
  });

  it('every allowlist entry says why its sites are not an access decision', () => {
    expect(result.unexplained).toEqual([]);
  });

  it('the scan covers the apps and packages it guards (sanity)', () => {
    expect(files.length).toBeGreaterThan(1000);
    for (const path of [
      'apps/web/src/app/api/drives/[driveId]/trash/route.ts',
      'apps/web/src/lib/users/visibility.ts',
      'apps/realtime/src/index.ts',
      'packages/lib/src/services/drive-member-service.ts',
    ]) {
      expect(files).toContain(path);
    }
    expect(files.some((f) => f.startsWith('packages/lib/src/permissions/'))).toBe(false);
  });
});

describe('access-gate scanner (planted shapes, fake files)', () => {
  const kinds = (source: string) => scanSource('apps/fake/planted.ts', source).map((s) => s.kind);

  it('counts every query shape of drive_members, each occurrence separately', () => {
    expect(kinds('await db.select().from(driveMembers).where(x);')).toEqual(['drive_members read']);
    expect(kinds('await db.select().from(pages).leftJoin(driveMembers, eq(a, b)).innerJoin( driveMembers, c);')).toEqual(['drive_members read', 'drive_members read']);
    expect(kinds('await tx.query.driveMembers.findFirst({ where });')).toEqual(['drive_members read']);
    expect(kinds('await db.execute(sql`SELECT 1 FROM pages p LEFT JOIN drive_members dm ON dm."driveId" = p."driveId"`);')).toEqual(['drive_members read']);
  });

  it('counts every comparison shape with an ownerId', () => {
    expect(kinds('if (drive.ownerId === userId) return true;')).toEqual(['drive ownerId comparison']);
    expect(kinds('if (userId !== targetDrive?.ownerId) return;')).toEqual(['drive ownerId comparison']);
    expect(kinds('where: and(eq(drives.id, id), eq(drives.ownerId, userId)),')).toEqual(['drive ownerId comparison']);
    expect(kinds('where: ne(userProfiles.userId, drives.ownerId),')).toEqual(['drive ownerId comparison']);
    expect(kinds('sql`WHERE d."ownerId" = ${userId}`')).toEqual(['drive ownerId comparison']);
    expect(kinds('const { ownerId } = drive; if (ownerId !== auth.userId) return;')).toEqual(['drive ownerId comparison']);
    expect(kinds('if (drive.ownerId == auth.userId) return;')).toEqual(['drive ownerId comparison']);
    expect(kinds('if (auth.userId != driveOwnerId) return;')).toEqual(['drive ownerId comparison']);
    expect(kinds('sql`${drives.ownerId} = ${auth.userId}`')).toEqual(['drive ownerId comparison']);
  });

  it('counts the drive_members table interpolated into a raw sql template', () => {
    expect(kinds('await db.execute(sql`select 1 from ${driveMembers} dm where dm."userId" = ${u}`);')).toEqual(['drive_members read']);
  });

  it('ignores writes, column selects, comments and prose', () => {
    expect(kinds('await db.insert(driveMembers).values(row);')).toEqual([]);
    expect(kinds('await tx.delete(driveMembers).where(eq(driveMembers.driveId, d));')).toEqual([]);
    expect(kinds('db.select({ ownerId: drives.ownerId }).from(drives);')).toEqual([]);
    expect(kinds('await db.update(drives).set({ ownerId: newOwnerId });')).toEqual([]);
    expect(kinds('// if (drive.ownerId === userId) — the old inline check')).toEqual([]);
    expect(kinds('/* db.select().from(driveMembers) */')).toEqual([]);
    expect(kinds("message.includes('drive_members');")).toEqual([]);
    expect(kinds('const byDrive = (d: Drive) => d.id;')).toEqual([]);
    expect(kinds('return { ownerId, name };')).toEqual([]);
  });

  it('attributes a site to the innermost function whose body holds it, not to a sibling closure above it', () => {
    const source = [
      'export async function outer(userId: string, drive: { ownerId: string }) {',
      '  const helper = (x: number) => {',
      '    return x + 1;',
      '  };',
      '  const nested = {',
      '    check: async ({ id }: { id: string }) => {',
      '      return db.select().from(driveMembers).where(eq(driveMembers.driveId, id));',
      '    },',
      '  };',
      '  return drive.ownerId === userId;',
      '}',
    ].join('\n');
    expect(scanSource('apps/fake/planted.ts', source).map((s) => `${s.anchor}:${s.kind}`)).toEqual([
      'check:drive_members read',
      'outer:drive ownerId comparison',
    ]);
  });

  const allowlist: AccessGateAllowlist = {
    'apps/fake/planted.ts': { legitimateWriter: { reads: 1, reason: 'writer reads the row it is about to update' } },
  };
  const legitimate = [
    'export async function legitimateWriter(d: string, u: string) {',
    '  const [row] = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, d), eq(driveMembers.userId, u)));',
    '  return row;',
    '}',
  ];

  it('passes a file whose only query is the allowlisted one', () => {
    expect(checkSites(scanSource('apps/fake/planted.ts', legitimate.join('\n')), allowlist)).toEqual({ mismatches: [], stale: [], unexplained: [] });
  });

  it('fails a planted ungated query in the SAME function as a legitimate one (the per-file check this replaces would pass it)', () => {
    const planted = [...legitimate.slice(0, 2), '  const all = await db.select().from(driveMembers).where(eq(driveMembers.driveId, d));', ...legitimate.slice(2)];
    const result = checkSites(scanSource('apps/fake/planted.ts', planted.join('\n')), allowlist);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain('legitimateWriter: found {"reads":2,"ownerCompares":0}, allowed {"reads":1,"ownerCompares":0}');
  });

  it('fails a planted inline gate in ANOTHER function of an allowlisted file', () => {
    const planted = [...legitimate, 'export async function canOpen(userId: string, drive: { ownerId: string }) {', '  return drive.ownerId === userId;', '}'];
    const result = checkSites(scanSource('apps/fake/planted.ts', planted.join('\n')), allowlist);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain('canOpen: found {"reads":0,"ownerCompares":1}, allowed {"reads":0,"ownerCompares":0}');
  });

  it('fails a planted inline gate in a file with no allowlist entry', () => {
    const result = checkSites(scanSource('apps/fake/other.ts', 'export function f(u: string, d: { ownerId: string }) {\n  return d.ownerId === u;\n}'), allowlist);
    expect(result.mismatches).toEqual([expect.stringContaining('apps/fake/other.ts › f')]);
  });

  it('reports an allowlist entry whose sites are gone, and an entry with no reason', () => {
    const result = checkSites([], { 'apps/fake/planted.ts': { gone: { reads: 1, reason: 'short' } } });
    expect(result.stale).toEqual(['apps/fake/planted.ts › gone']);
    expect(result.unexplained).toEqual(['apps/fake/planted.ts › gone']);
  });
});
