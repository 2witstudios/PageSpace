/**
 * Seam guard — [D-OW-33] every write that can LOOSEN access passes the lapse guard.
 *
 * A lapsed org may only restrict (SEAT-9 as amended by D-OW-33): "changes that loosen access stay refused until
 * paid; billing never blocks security". The writes that can loosen are the inserts and updates of the tables whose
 * rows grant access (loosening-write-scan.ts). This test finds EVERY such write in the tree, names the function it
 * sits in, and requires that function to be in the ledger below with one of three verdicts:
 *
 *   - `guard: 'self'`: the function itself calls a lapse guard (GUARD_CALL);
 *   - `guard: 'caller'`: it is only ever reached from the listed functions, each of which calls a lapse guard; every
 *     reference to it in the tree is checked to sit inside one of them (or inside an argument of a call to one);
 *   - `exempt`: why the write cannot loosen while lapsed, and the exact writes the exemption covers, so a NEW kind of
 *     write added to an exempt function is not covered by an old reason.
 *
 * A new function with a loosening write fails here until it is guarded or its exemption is recorded; a ledgered
 * function that no longer writes must leave the ledger. Every lapse guard other than the root one is checked to end
 * in `checkOrgMayLoosen` (or the SEAT-9 whole-capability gate `checkOrgActive`).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT, listSourceFiles } from './walk';
import { enclosingFunction, functionName, functionText, scanFile, scanSource, stripComments, type LooseningWrite } from './loosening-write-scan';

/** The guards. `checkOrgMayLoosen` is the one D-OW-33 guard; `checkOrgActive` is SEAT-9's (refuses the whole capability while lapsed). */
const ROOT_GUARDS = ['checkOrgMayLoosen', 'checkOrgActive'] as const;
/** Helpers that end in a root guard, each verified below: `file#function`. */
const GUARD_HELPERS: Readonly<Record<string, string>> = {
  checkDriveMayLoosen: 'packages/lib/src/permissions/org-lapse-guard.ts#checkDriveMayLoosen',
  checkPageMayLoosen: 'packages/lib/src/permissions/org-lapse-guard.ts#checkPageMayLoosen',
  guardDriveAccess: 'packages/lib/src/permissions/org-lapse-guard.ts#guardDriveAccess',
};
const GUARD_NAMES = [...ROOT_GUARDS, ...Object.keys(GUARD_HELPERS)];
export const GUARD_CALL = new RegExp(`\\b(?:${GUARD_NAMES.join('|')})\\s*\\(`);

type Verdict = { guard: 'self' } | { guard: 'caller'; by: readonly string[] } | { exempt: string; writes: readonly string[] };

const SELF = { guard: 'self' } as const;
const ROLLBACK = ['apps/web/src/services/api/rollback/execute.ts#executeRollback'];
const MEMBER_ACCESS = 'packages/lib/src/services/drive-member-service.ts#updateMemberAccess';
const NEW_AGENT_IN_ITS_OWN_DRIVE =
  'a new AI_CHAT page joins its OWN drive as a plain MEMBER: the page is new, so only people who already reach the drive reach the agent';

/**
 * The ledger: every function in the tree with a write that can loosen access. Keyed `file#function`.
 * Each guarded site is tested both ways against a real Postgres in org-lapse-loosening.integration.test.ts.
 */
export const LOOSENING_WRITE_LEDGER: Readonly<Record<string, Verdict>> = {
  // ── drive members, re-invites, invitations (inventory #1-#10) ──────────────────────────────────────────────
  'packages/lib/src/services/drive-member-service.ts#updateMemberRole': { guard: 'caller', by: [MEMBER_ACCESS] },
  'packages/lib/src/services/drive-member-service.ts#updateMemberPermissions': { guard: 'caller', by: [MEMBER_ACCESS] },
  'apps/web/src/lib/repositories/drive-invite-repository.ts#driveInviteRepository.createAcceptedMemberWithPermissions': SELF,
  'apps/web/src/lib/repositories/drive-invite-repository.ts#driveInviteRepository.upgradeMemberWithPermissions': SELF,
  'apps/web/src/lib/repositories/drive-invite-repository.ts#driveInviteRepository.createPendingInvite': SELF,
  'apps/web/src/lib/repositories/drive-invite-repository.ts#driveInviteRepository.consumeInviteAndCreateMembership': SELF,
  'apps/web/src/lib/repositories/page-invite-repository.ts#pageInviteRepository.consumeInviteAndGrantPage': SELF,
  'apps/web/src/lib/repositories/page-invite-repository.ts#pageInviteRepository.createDirectPagePermission': SELF,
  'apps/web/src/lib/repositories/page-invite-repository.ts#pageInviteRepository.createPendingInvite': SELF,
  // ── page grants (#11) ───────────────────────────────────────────────────────────────────────────────────
  'packages/lib/src/permissions/permission-mutations.ts#grantPagePermission': SELF,
  // ── share links (#13-#16) ───────────────────────────────────────────────────────────────────────────────
  'packages/lib/src/permissions/share-link-service.ts#createDriveShareLink': SELF,
  'packages/lib/src/permissions/share-link-service.ts#createPageShareLink': SELF,
  'packages/lib/src/permissions/share-link-service.ts#insertDriveLinkMember': { guard: 'caller', by: ['packages/lib/src/permissions/share-link-service.ts#admittedWrite'] },
  'packages/lib/src/permissions/share-link-service.ts#insertPageLinkGuest': { guard: 'caller', by: ['packages/lib/src/permissions/share-link-service.ts#admittedWrite'] },
  'packages/lib/src/permissions/share-link-service.ts#redeemDriveShareLink': {
    exempt: "the link's use counter, bumped after admittedWrite (guarded) wrote the membership",
    writes: ['update(driveShareLinks)'],
  },
  'packages/lib/src/permissions/share-link-service.ts#redeemPageShareLink': {
    exempt: "the link's use counter, bumped after admittedWrite (guarded) wrote the grant",
    writes: ['update(pageShareLinks)'],
  },
  'packages/lib/src/permissions/share-link-service.ts#completeApprovedLinkAdmission': {
    exempt: "the link's use counter after an approved admission: the approval is SEAT-9 gated (claimGuestApprovalDecision) and the member write goes through admittedWrite",
    writes: ['update(driveShareLinks)', 'update(pageShareLinks)'],
  },
  'packages/lib/src/permissions/share-link-service.ts#revokeDriveShareLink': { exempt: 'revoking a link only restricts', writes: ['update(driveShareLinks)'] },
  'packages/lib/src/permissions/share-link-service.ts#revokePageShareLink': { exempt: 'revoking a link only restricts', writes: ['update(pageShareLinks)'] },
  // ── org: join requests, lead, invitations, roles (#17-#20) ─────────────────────────────────────────────
  'packages/lib/src/services/org-drive-service.ts#changeOrgDriveLead': SELF,
  'packages/lib/src/services/org-drive-service.ts#changeDriveVisibility': SELF,
  'packages/lib/src/services/org-drive-service.ts#moveDriveToOrg': SELF,
  'packages/lib/src/services/org-drive-service.ts#moveDriveOutOfOrg': {
    exempt: 'the drive leaves the org for its own lead: org members lose their org access and nobody gains any',
    writes: ['update(drives).set({ orgId })'],
  },
  'packages/lib/src/organizations/invitations.ts#acceptInvitation': SELF,
  'packages/lib/src/organizations/invitations.ts#createOrRotateInvitation': SELF,
  'packages/lib/src/organizations/invitations.ts#resendInvitation': SELF,
  'packages/lib/src/organizations/domains.ts#autoJoinVerifiedDomainOrg': SELF,
  'packages/lib/src/organizations/membership.ts#changeMemberRole': SELF,
  // Inventory #19, orchestrator ruling: EXEMPT ON CONDITION. A transfer stays possible while lapsed (handing off and
  // offboarding are never blocked) provided it grants no new access: the recipient must already be an accepted org
  // member (refused otherwise, lapsed or not) who already reaches every drive the Owner reaches, i.e. an Admin. A
  // lapsed transfer to a plain Member (who would gain every Restricted/Private drive) is refused, in the transfer's
  // transaction: checkOrgMayLoosen(tx, orgId, ownershipTransferWidens(targetRole)).
  'packages/lib/src/organizations/membership.ts#transferOwnership': SELF,
  'packages/lib/src/organizations/repository.ts#createOrganization': {
    exempt: "the creator's own Owner row in a brand-new org; an org is lapsed from creation (D-OW-30), so guarding it would forbid creating orgs",
    writes: ['insert(orgMembers)'],
  },
  'packages/lib/src/organizations/deletion.ts#deleteOrganization': {
    exempt: "dissolving the org: each drive leaves it for a person the Owner chose, so the org's access ends and none is granted",
    writes: ['update(drives).set({ orgId, ownerId, ... })'],
  },
  'packages/lib/src/organizations/leave.ts#reassignLedOrgDrives': {
    exempt: "a departing lead's drives pass to the org Owner: required on departure (billing never blocks security)",
    writes: ['update(drives).set({ ownerId })'],
  },
  'packages/lib/src/services/org-membership-sync.ts#applyPlans': {
    exempt:
      'materializes org rows its caller decided; every loosening caller is guarded first: join-request approval (answerDriveJoinRequest), invitation acceptance, domain auto-join, visibility toward Open; the rest remove or demote',
    writes: ['insert(driveMembers)', 'update(driveMembers)'],
  },
  'packages/lib/src/organizations/policy-suspension.ts#reconcileShareLinks': {
    exempt: 'follows a policy write: suspending only restricts, and lifting a suspension follows a policy loosening, which is gated (policies.ts)',
    writes: ['update(driveShareLinks)', 'update(pageShareLinks)'],
  },
  // ── drive roles (#21-#23) ───────────────────────────────────────────────────────────────────────────────
  'packages/lib/src/services/drive-role-service.ts#createDriveRole': SELF,
  'packages/lib/src/services/drive-role-service.ts#updateDriveRole': SELF,
  'packages/lib/src/services/drive-role-service.ts#unsetOtherDefaultRoles': {
    guard: 'caller',
    by: ['packages/lib/src/services/drive-role-service.ts#createDriveRole', 'packages/lib/src/services/drive-role-service.ts#updateDriveRole'],
  },
  'packages/lib/src/permissions/org-drive-membership.ts#followDriveDefaultRole': {
    exempt: 'runs inside guardOpenRoleFloor, within a role write that guardDriveAccess wraps (drive-role-service, restore, rollback), so its effect is in the after-snapshot',
    writes: ['update(driveMembers)'],
  },
  // ── rollback, redo, backup restore (#24-#26) ───────────────────────────────────────────────────────────────
  'apps/web/src/services/api/rollback/rollback-executors.ts#rollbackDriveChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/rollback-executors.ts#rollbackMemberChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/rollback-executors.ts#rollbackPermissionChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/rollback-executors.ts#rollbackRoleChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/redo-executors.ts#redoDriveChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/redo-executors.ts#redoMemberChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/redo-executors.ts#redoPermissionChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/rollback/redo-executors.ts#redoRoleChange': { guard: 'caller', by: ROLLBACK },
  'apps/web/src/services/api/restore-permissions-service.ts#applyPermRestoreOps': {
    guard: 'caller',
    by: ['apps/web/src/app/api/drives/[driveId]/backups/[backupId]/restore/route.ts#POST'],
  },
  'packages/lib/src/permissions/guest-holds.ts#reinsertHeldAccess': {
    exempt: "re-inserts a parked guest (member row, grants, token scopes): reached from restoreOrgGuests (a guests-policy loosening, gated in policies.ts) and an approved page grant (SEAT-9 gated in claimGuestApprovalDecision)",
    writes: ['insert(driveMembers)', 'insert(pagePermissions)', 'insert(mcpTokenDrives)'],
  },
  'packages/lib/src/permissions/page-grant-admission.ts#completeApprovedPageGrant': {
    exempt: 'replays an approved guest request; approving is SEAT-9 gated (claimGuestApprovalDecision refuses while lapsed)',
    writes: ['insert(pagePermissions)'],
  },
  // ── drive agents (#27) ─────────────────────────────────────────────────────────────────────────────────
  'packages/lib/src/services/drive-agent-service.ts#addAgentToDrive': SELF,
  'packages/lib/src/services/drive-agent-service.ts#setAgentDriveIncludeContext': SELF,
  'apps/web/src/app/api/drives/[driveId]/agents/[agentPageId]/route.ts#PATCH': SELF,
  'packages/lib/src/services/drive-agent-service.ts#recapAgentMembershipsGrantedBy': {
    exempt: "caps agent memberships at their granter's current role: only lowers",
    writes: ['update(driveAgentMembers)'],
  },
  'apps/web/src/app/api/ai/page-agents/create/route.ts#POST': { exempt: NEW_AGENT_IN_ITS_OWN_DRIVE, writes: ['insert(driveAgentMembers)'] },
  'apps/web/src/lib/ai/tools/page-write-tools.ts#create_page.execute': { exempt: NEW_AGENT_IN_ITS_OWN_DRIVE, writes: ['insert(driveAgentMembers)'] },
  'apps/web/src/services/api/page-service.ts#pageService.createPage': { exempt: NEW_AGENT_IN_ITS_OWN_DRIVE, writes: ['insert(driveAgentMembers)'] },
  // ── MCP token (app) drive scopes (#28, review P1-1) ─────────────────────────────────────────────────
  // An explicit token role is NOT bounded by the owner's access (resolveExplicitAppRoleAccess): the drive admin's
  // re-role of a key loosens and is guarded (guardDriveAccess, which now snapshots token scopes).
  'apps/web/src/app/api/drives/[driveId]/apps/[tokenId]/route.ts#PATCH': SELF,
  'apps/web/src/lib/repositories/session-repository.ts#run': {
    exempt: "the token OWNER's own mint and re-scope: bounded by the owner. validateDriveScopeAccess refuses a scope wider than the owner's own role (an ADMIN scope for a member, another custom role, or the plain role for a member a custom role restricts: scopeWidensCaller), and every explicit key resolves as the INTERSECTION with its owner's current access (app-permissions intersectPermissionLevels), so it never reads past them, paid or lapsed",
    writes: ['insert(mcpTokenDrives)'],
  },
  // ── pages leaving a drive (review P2-4, orchestrator ruling) ───────────────────────────────────────────
  // Moving (or copying, api/pages/bulk-copy) pages OUT of a lapsed org's drive writes read-only content and widens
  // its audience: refused, checked against the SOURCE drive's org. Data export (account / GDPR) stays available.
  'apps/web/src/services/api/page-cross-drive-move-service.ts#movePagesToDrive': SELF,
  'apps/web/src/services/api/page-cross-drive-move-service.ts#cascadeDriveIdToDescendants': {
    guard: 'caller',
    by: ['apps/web/src/services/api/page-cross-drive-move-service.ts#movePagesToDrive'],
  },
  // ── calendar event visibility (orchestrator ruling, review #2849 r2) ──────────────────────────────────
  // An org-drive event made more visible (Private < Attendees only < Drive) loosens who reads it.
  'apps/web/src/app/api/calendar/events/[eventId]/route.ts#PATCH': SELF,
  'apps/web/src/lib/integrations/google-calendar/sync-service.ts#upsertEvent': SELF,
  // ── custom domains (#29) ────────────────────────────────────────────────────────────────────────────────
  'apps/web/src/app/api/drives/[driveId]/domains/route.ts#POST': SELF,
  // ── drives: other writers of ownerId / orgId / visibility ─────────────────────────────────────────────
  'apps/web/src/app/api/account/handle-drive/route.ts#POST': {
    exempt: 'personal drives only: an org drive is refused (409) before the transfer, and the new owner must already be an accepted drive admin',
    writes: ['update(drives).set({ ownerId })'],
  },
  'packages/lib/src/services/drive-service.ts#updateDrive': {
    exempt: 'its update object is typed to name, prompt, home page and publish fields: never ownerId, orgId or orgVisibility',
    writes: ['update(drives).set({ <non-literal> })'],
  },
  'packages/lib/src/services/drive-service.ts#updateDriveLastAccessed': {
    exempt: "the lead's OWNER self-heal row on a PERSONAL drive (org drives are excluded) and a last-accessed stamp",
    writes: ['insert(driveMembers)', 'update(driveMembers)'],
  },
};

const NOT_APPLICATION_CODE = ['packages/db/', 'apps/e2e/', 'packages/lib/src/test/'];

function scanTree(): LooseningWrite[] {
  return listSourceFiles(['apps', 'packages'])
    .filter((f) => !NOT_APPLICATION_CODE.some((p) => f.startsWith(p)) && !f.includes('/scripts/'))
    .flatMap(scanFile);
}

const keyOf = (w: { file: string; fn: string }) => `${w.file}#${w.fn}`;
const splitKey = (key: string): { file: string; fn: string } => {
  const at = key.lastIndexOf('#');
  return { file: key.slice(0, at), fn: key.slice(at + 1) };
};

/** Does the ledgered function's own code call a guard? */
function callsGuard(key: string): boolean {
  const { file, fn } = splitKey(key);
  const text = functionText(file, fn);
  return text !== null && GUARD_CALL.test(stripComments(text));
}

/**
 * Every place outside its own declaration where `fn` (the last segment of a ledgered name) is referenced, with the
 * named function around it and the names of every call it sits in the arguments of.
 */
function referencesOf(name: string, files: readonly string[]): Array<{ file: string; line: number; enclosing: string; insideCallsTo: string[] }> {
  const bare = name.split('.').pop() as string;
  const word = new RegExp(`\\b${bare}\\b`);
  const out: Array<{ file: string; line: number; enclosing: string; insideCallsTo: string[] }> = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!word.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === bare) {
        const p = node.parent;
        const isDeclarationName =
          ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name === node) ||
          ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p);
        if (!isDeclarationName) {
          const fnNode = enclosingFunction(node);
          const insideCallsTo: string[] = [];
          let cur: ts.Node = node;
          while (cur.parent) {
            const parent = cur.parent;
            if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === cur)) {
              const callee = parent.expression;
              if (ts.isIdentifier(callee)) insideCallsTo.push(callee.text);
              else if (ts.isPropertyAccessExpression(callee)) insideCallsTo.push(callee.name.text);
            }
            cur = parent;
          }
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            enclosing: fnNode ? (functionName(fnNode) ?? '<anonymous>') : '<module>',
            insideCallsTo,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('seam: [D-OW-33] every write that can loosen access passes the lapse guard', () => {
  const writes = scanTree();
  const byFunction = new Map<string, LooseningWrite[]>();
  for (const w of writes) byFunction.set(keyOf(w), [...(byFunction.get(keyOf(w)) ?? []), w]);

  it('SEAT-9 (partial) [D-OW-33] no function with a loosening write is missing from the ledger', () => {
    const missing = [...byFunction.entries()]
      .filter(([key]) => !(key in LOOSENING_WRITE_LEDGER))
      .map(([key, ws]) => `  ${key}  ${ws.map((w) => `:${w.line} ${w.what}`).join(', ')}`);
    expect(
      missing,
      'Writes that can loosen access with no ledger entry. Call checkOrgMayLoosen (or checkDriveMayLoosen / ' +
        'checkPageMayLoosen / guardDriveAccess) in the write, or record why it cannot loosen while lapsed:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('SEAT-9 (partial) [D-OW-33] every ledgered function still writes (the ledger only names real sites)', () => {
    const stale = Object.keys(LOOSENING_WRITE_LEDGER).filter((key) => !byFunction.has(key));
    expect(stale, 'These ledger entries no longer write; remove them from LOOSENING_WRITE_LEDGER').toEqual([]);
  });

  it("SEAT-9 (partial) [D-OW-33] each 'self' site calls a lapse guard in its own code", () => {
    const unguarded = Object.entries(LOOSENING_WRITE_LEDGER)
      .filter(([, v]) => 'guard' in v && v.guard === 'self')
      .map(([key]) => key)
      .filter((key) => !callsGuard(key));
    expect(unguarded, 'Ledgered as guarded, but no lapse guard call is in the function').toEqual([]);
  });

  it("SEAT-9 (partial) [D-OW-33] each 'caller' site is reached only from guarded callers", () => {
    const files = listSourceFiles(['apps', 'packages']).filter((f) => !NOT_APPLICATION_CODE.some((p) => f.startsWith(p)));
    const problems: string[] = [];
    for (const [key, v] of Object.entries(LOOSENING_WRITE_LEDGER)) {
      if (!('guard' in v) || v.guard !== 'caller') continue;
      for (const by of v.by) if (!callsGuard(by)) problems.push(`${key}: its caller ${by} calls no lapse guard`);
      const { fn } = splitKey(key);
      const callers = v.by.map(splitKey);
      for (const ref of referencesOf(fn, files)) {
        const fromCaller = callers.some((c) => c.file === ref.file && (c.fn === ref.enclosing || ref.insideCallsTo.includes(c.fn.split('.').pop() as string)));
        const isItself = ref.file === splitKey(key).file && ref.enclosing === fn;
        if (!fromCaller && !isItself) problems.push(`${key}: referenced at ${ref.file}:${ref.line} in ${ref.enclosing}, not a listed guarded caller`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('SEAT-9 (partial) [D-OW-33] each exemption gives a reason and covers exactly the writes it names', () => {
    const problems: string[] = [];
    for (const [key, v] of Object.entries(LOOSENING_WRITE_LEDGER)) {
      if (!('exempt' in v)) continue;
      if (v.exempt.trim().length < 20) problems.push(`${key}: the exemption needs a real reason`);
      const actual = [...new Set((byFunction.get(key) ?? []).map((w) => w.what))].sort();
      const named = [...new Set(v.writes)].sort();
      if (JSON.stringify(actual) !== JSON.stringify(named)) problems.push(`${key}: exempts ${JSON.stringify(named)} but writes ${JSON.stringify(actual)}`);
    }
    expect(problems).toEqual([]);
  });

  it('SEAT-9 (partial) [D-OW-33] every guard helper ends in checkOrgMayLoosen or checkOrgActive', () => {
    const roots = new RegExp(`\\b(?:${ROOT_GUARDS.join('|')})\\s*\\(`);
    const broken = Object.entries(GUARD_HELPERS)
      .filter(([, key]) => {
        const { file, fn } = splitKey(key);
        const text = functionText(file, fn);
        return text === null || !roots.test(stripComments(text));
      })
      .map(([name]) => name);
    expect(broken).toEqual([]);
  });

  it('the scanner sees each loosening write shape and ignores restricting ones', () => {
    const shapes = (src: string) => scanSource('x.ts', src).map((w) => `${w.fn}:${w.what}`);
    expect(shapes('async function a(tx) { await tx.insert(driveMembers).values({}); }')).toEqual(['a:insert(driveMembers)']);
    expect(shapes('const b = async () => db.update(pagePermissions).set({ canEdit: true });')).toEqual(['b:update(pagePermissions)']);
    expect(shapes('const repo = { async c() { await db.insert(driveShareLinks).values({}); } };')).toEqual(['repo.c:insert(driveShareLinks)']);
    expect(shapes('function d() { return db.transaction(async (tx) => tx.insert(orgMembers).values({})); }')).toEqual(['d:insert(orgMembers)']);
    expect(shapes('function e() { return db.update(drives).set({ orgVisibility: "OPEN" }); }')).toEqual(['e:update(drives).set({ orgVisibility })']);
    expect(shapes('function f() { return db.update(drives).set({ ...patch }); }')).toEqual(['f:update(drives).set({ ... })']);
    expect(shapes('function g() { return db.update(drives).set(patch); }')).toEqual(['g:update(drives).set({ <non-literal> })']);
    expect(shapes('function h() { return db.insert(pendingInvites).values({}); }')).toEqual(['h:insert(pendingInvites)']);
    expect(shapes('function t() { return db.update(mcpTokenDrives).set({ role: "ADMIN" }); }')).toEqual(['t:update(mcpTokenDrives)']);
    expect(shapes('function p() { return db.update(pages).set({ isPrivate: false }); }')).toEqual(['p:update(pages).set({ isPrivate })']);
    expect(shapes('function q() { return db.update(pages).set({ driveId: d, defaultEnvId: null }); }')).toEqual(['q:update(pages).set({ driveId })']);
    expect(shapes('function r() { return db.update(pages).set({ title: "x" }); }')).toEqual([]);
    expect(shapes('function c() { return db.update(calendarEvents).set({ visibility: "DRIVE" }); }')).toEqual(['c:update(calendarEvents).set({ visibility })']);
    expect(shapes('function i() { return sql`insert into drive_members (id) values (1)`; }')).toEqual(['i:raw sql']);
    expect(shapes('const tools = { create_page: tool({ execute: async () => db.insert(driveAgentMembers).values({}) }) };')).toEqual(['create_page.execute:insert(driveAgentMembers)']);
    // Restricting or unrelated: deletes, reads, a drives rename, a pending invite consumed.
    expect(shapes('function j() { return db.delete(driveMembers).where(x); }')).toEqual([]);
    expect(shapes('function k() { return db.select().from(driveMembers); }')).toEqual([]);
    expect(shapes('function l() { return db.update(drives).set({ name: "x" }); }')).toEqual([]);
    expect(shapes('function m() { return db.update(pendingInvites).set({ consumedAt: now }); }')).toEqual([]);
  });

  it('the guard pattern matches a call and ignores a mention', () => {
    expect(GUARD_CALL.test('const lapsed = await checkOrgMayLoosen(tx, orgId, true);')).toBe(true);
    expect(GUARD_CALL.test('await deps.checkDriveMayLoosen (tx, id, loosens)')).toBe(true);
    expect(GUARD_CALL.test('return guardDriveAccess(tx, driveId, {}, write);')).toBe(true);
    expect(GUARD_CALL.test("import { checkOrgMayLoosen } from './status';")).toBe(false);
  });
});
