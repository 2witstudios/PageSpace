/**
 * Seam guard: review #2849 r6. No key reaches past its owner, by any reader of the key's drive scope.
 *
 * Reviews r4, r5 and r6 each found one more reader that took a key's drive scope (its `mcp_token_drives` rows, or
 * the scope on the authenticated principal) as membership without asking whether the key's OWNER is still a member
 * of the drive. This test finds EVERY read of that scope in the tree (key-scope-read-scan.ts) and requires the
 * function it sits in to be in the ledger below with one of five verdicts:
 *
 *   - `owner-bound`: the function IS one of the owner-bound helpers (OWNER_BOUND below); each one is checked to call
 *     its owner check;
 *   - `gated`: it reads the scope and decides access only through an owner-bound helper (its code calls one);
 *   - `primitive`: the raw row read behind the owner-bound helpers, called only from inside them (checked);
 *   - `ceiling`: the scope only NARROWS what the owner already reaches, or refuses (the reason says how);
 *   - `not-access`: the read is not an access decision: authentication, key management or display, revocation
 *     bookkeeping, the lapse guard's snapshot (the reason says which).
 *
 * A new reader fails here until it is classified. A ledgered function that no longer reads must leave.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT, listSourceFiles } from './walk';
import { enclosingFunction, functionName, functionText, stripComments } from './loosening-write-scan';
import { scanScopeReads, scanScopeReadsInFile, type ScopeRead } from './key-scope-read-scan';

const APP_PERMISSIONS = 'packages/lib/src/permissions/app-permissions.ts';
const PRINCIPAL_PERMISSIONS = 'apps/web/src/lib/auth/principal-permissions.ts';

/**
 * The owner-bound helpers, each with the call that makes it so: a membership answer requires the owner to be a
 * current drive member (isUserDriveMember); an access level or page set is the owner's own, intersected with the
 * key's role (getUserAccessLevel, or the shared page resolver over the owner's accessible pages).
 */
const OWNER_BOUND: Readonly<Record<string, { file: string; calls: readonly string[] }>> = {
  hasAppDriveMembership: { file: APP_PERMISSIONS, calls: ['isUserDriveMember'] },
  hasScopedDriveMembership: { file: APP_PERMISSIONS, calls: ['isUserDriveMember'] },
  getAppDriveMembership: { file: APP_PERMISSIONS, calls: ['isUserDriveMember'] },
  getEffectiveScopedDriveMembership: { file: APP_PERMISSIONS, calls: ['isUserDriveMember'] },
  getAppAccessLevel: { file: APP_PERMISSIONS, calls: ['getUserAccessLevel'] },
  getScopedAccessLevel: { file: APP_PERMISSIONS, calls: ['getUserAccessLevel'] },
  getAppDriveAccessLevel: { file: APP_PERMISSIONS, calls: ['getUserAccessLevel'] },
  getScopedDriveAccessLevel: { file: APP_PERMISSIONS, calls: ['getUserAccessLevel'] },
  getAppAccessiblePagesInDrive: { file: APP_PERMISSIONS, calls: ['resolveAccessiblePagesForMembership'] },
  getScopedAccessiblePagesInDrive: { file: APP_PERMISSIONS, calls: ['resolveAccessiblePagesForMembership'] },
  resolveAccessiblePagesForMembership: { file: APP_PERMISSIONS, calls: ['getUserAccessiblePagesInDriveWithDetails'] },
  getPrincipalDriveIds: { file: PRINCIPAL_PERMISSIONS, calls: ['hasAppDriveMembership', 'hasScopedDriveMembership'] },
};
const OWNER_BOUND_CALL = new RegExp(`\\b(?:${Object.keys(OWNER_BOUND).join('|')})\\s*\\(`);

type Verdict =
  | { kind: 'owner-bound' }
  | { kind: 'gated' }
  | { kind: 'primitive' }
  | { kind: 'ceiling'; why: string }
  | { kind: 'not-access'; why: string };

const OWNER_BOUND_V = { kind: 'owner-bound' } as const;
const GATED = { kind: 'gated' } as const;
const ceiling = (why: string): Verdict => ({ kind: 'ceiling', why });
const notAccess = (why: string): Verdict => ({ kind: 'not-access', why });

const OWN_ACTIVITY = ceiling("the caller's OWN activity rows (userId = the owner), narrowed to the scoped drives");
const EVENT_ATTENDEES = ceiling(
  "refuses unless an event drive is in scope; the event is then decided on the OWNER's own standing (creator, attendee, isUserMemberOfAnyEventDrive)",
);
const AI_CONTEXT = ceiling(
  "copies the scope into the AI tool context (mcpAllowedDriveIds) as a ceiling; the tools decide each drive through actor-permissions (owner-bound helpers) and filter by the ceiling",
);
const SCOPE_REFUSAL = ceiling("refuses a target outside the scope; access to the target is then the principal's (owner-bound principal helpers)");
const OWN_CONVERSATION = ceiling("the owner's OWN conversations, refused or narrowed outside the scope");
const AGENT_RUNTIME = ceiling('forwards or applies the credential ceiling to an agent session/workspace: it only refuses or narrows');
const AGENT_ACCOUNTS = ceiling('the agent-account caller ceiling: only ever narrows (isDriveWithinCredentialScope) or serializes it into the grant');
const PREDICATE = notAccess('a yes/no "is this credential drive-scoped at all" test; grants nothing');
const KEY_ADMIN = notAccess("a drive admin managing or listing the keys that hold a row in THEIR drive (the route requires drive admin)");
const KEY_SETTINGS = notAccess("the owner's own key settings: shows the key's configured scope");
const LEGACY_SCOPE_CHECKS = ceiling('the scope check helpers: refuse or narrow a drive/page/list the owner already reaches');

/** Every function in the tree that reads a key's drive scope. Keyed `file#function`. */
const KEY_SCOPE_READ_LEDGER: Readonly<Record<string, Verdict>> = {
  // ── owner-bound helpers and their primitive ──────────────────────────────────────────────────────────────
  [`${APP_PERMISSIONS}#fetchAppMembershipContext`]: { kind: 'primitive' },
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalDriveIds`]: OWNER_BOUND_V,
  // ── the principal helpers: every scoped branch goes through an owner-bound helper ───────────────────────
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalAccessLevel`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#canPrincipalViewPage`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#canPrincipalEditPage`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#canPrincipalDeletePage`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#canPrincipalSharePage`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#isPrincipalDriveMember`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalDriveAccess`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#isPrincipalDriveOwnerOrAdmin`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalDriveAccessLevel`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalDriveMembership`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalAccessiblePagesInDrive`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#getPrincipalBatchPagePermissions`]: GATED,
  [`${PRINCIPAL_PERMISSIONS}#isScopedMCPAuth`]: PREDICATE,
  [`${PRINCIPAL_PERMISSIONS}#isDriveScopedPrincipal`]: PREDICATE,
  [`${PRINCIPAL_PERMISSIONS}#resolveDispatchedPrincipal`]: notAccess(
    "rebuilds a dispatched worker's originating MCP principal, so the owner-bound helpers apply to it",
  ),
  // ── drive listings (review r5) ───────────────────────────────────────────────────────────────────────────
  'apps/web/src/app/api/drives/route.ts#GET': GATED,
  'apps/web/src/app/api/drives/route.ts#getMembership': GATED,
  'apps/web/src/app/api/mcp/drives/route.ts#GET': GATED,
  'apps/web/src/app/api/mcp/drives/route.ts#POST': SCOPE_REFUSAL,
  // ── authentication and the raw ceiling accessor ─────────────────────────────────────────────────────────
  'apps/web/src/lib/auth/index.ts#validateMCPToken': notAccess(
    "authentication: loads the key's scope rows into the principal; every decision reads them through this ledger",
  ),
  'apps/web/src/lib/auth/index.ts#loadServicePrincipal': notAccess("builds a dispatched worker's service principal carrying the originating ceiling"),
  'apps/web/src/lib/auth/index.ts#getAllowedDriveIds': notAccess('the raw ceiling accessor: each caller is ledgered here by its own verdict'),
  'apps/web/src/lib/auth/index.ts#checkMCPDriveScope': LEGACY_SCOPE_CHECKS,
  'apps/web/src/lib/auth/index.ts#checkMCPPageScope': LEGACY_SCOPE_CHECKS,
  'apps/web/src/lib/auth/index.ts#filterDrivesByMCPScope': LEGACY_SCOPE_CHECKS,
  'apps/web/src/lib/auth/index.ts#checkMCPCreateScope': LEGACY_SCOPE_CHECKS,
  // ── routes that narrow or refuse by the scope ───────────────────────────────────────────────────────────
  'apps/web/src/app/api/activities/route.ts#GET': OWN_ACTIVITY,
  'apps/web/src/app/api/activities/actors/route.ts#GET': OWN_ACTIVITY,
  'apps/web/src/app/api/activities/export/route.ts#GET': OWN_ACTIVITY,
  'apps/web/src/app/api/ai/page-agents/consult/route.ts#POST': AI_CONTEXT,
  'apps/web/src/app/api/v1/chat/completions/route.ts#POST': AI_CONTEXT,
  'apps/web/src/app/api/ai/page-agents/multi-drive/route.ts#GET': ceiling("filters the OWNER's accessible drives (listAccessibleDrives) to the scope"),
  'apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts#GET': EVENT_ATTENDEES,
  'apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts#POST': EVENT_ATTENDEES,
  'apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts#PATCH': EVENT_ATTENDEES,
  'apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts#DELETE': EVENT_ATTENDEES,
  'apps/web/src/app/api/internal/agent-dispatch/route.ts#POST': ceiling(
    'carries the originating ceiling onto the worker principal (and refuses a scoped credential on a global worker); access then resolves through resolveDispatchedPrincipal',
  ),
  'apps/web/src/app/api/mcp/documents/route.ts#POST': SCOPE_REFUSAL,
  'apps/web/src/app/api/mcp/sheets/route.ts#POST': SCOPE_REFUSAL,
  'apps/web/src/app/api/pages/bulk-copy/route.ts#POST': SCOPE_REFUSAL,
  'apps/web/src/app/api/pages/bulk-delete/route.ts#DELETE': SCOPE_REFUSAL,
  'apps/web/src/app/api/pages/bulk-move/route.ts#POST': SCOPE_REFUSAL,
  'apps/web/src/app/api/v1/conversations/route.ts#GET': OWN_CONVERSATION,
  'apps/web/src/app/api/v1/conversations/route.ts#POST': OWN_CONVERSATION,
  'apps/web/src/app/api/v1/conversations/[id]/route.ts#GET': OWN_CONVERSATION,
  'apps/web/src/app/api/v1/conversations/[id]/route.ts#DELETE': OWN_CONVERSATION,
  'apps/web/src/app/api/v1/models/route.ts#GET': ceiling('narrows AI_CHAT pages to the scope; each page is then filtered by getPrincipalBatchPagePermissions (owner-bound)'),
  'apps/web/src/lib/wallets/wallet-route.ts#refuseScopedTokenForAccountRead': SCOPE_REFUSAL,
  'apps/web/src/lib/agent-workspaces/credential-scope.ts#isWorkspaceInCredentialScope': AGENT_RUNTIME,
  // ── key administration and display ──────────────────────────────────────────────────────────────────────
  'apps/web/src/app/api/drives/[driveId]/apps/[tokenId]/route.ts#PATCH': KEY_ADMIN,
  'apps/web/src/app/api/drives/[driveId]/apps/[tokenId]/route.ts#DELETE': KEY_ADMIN,
  'apps/web/src/app/api/drives/[driveId]/apps/members/route.ts#GET': KEY_ADMIN,
  'apps/web/src/lib/repositories/session-repository.ts#sessionRepository.findUserMcpTokensWithDrives': KEY_SETTINGS,
  'apps/web/src/components/layout/middle-content/page-views/settings/mcp/MCPSettingsView.tsx#MCPSettingsView': KEY_SETTINGS,
  'apps/web/src/components/layout/middle-content/page-views/settings/mcp/MCPSettingsView.tsx#openEditDialog': KEY_SETTINGS,
  'packages/lib/src/auth/mcp-token-scopes.ts#computeMcpTokenActionBinding': notAccess("the mint/re-scope action binding over the requested scope (the mint bound is validateDriveScopeAccess's)"),
  // ── AI chat pipeline and tools: the scope as a ceiling ──────────────────────────────────────────────────
  'apps/web/src/lib/ai/chat-pipeline/global-chat-turn.ts#runGlobalChatTurn': ceiling("narrows the OWNER's home-drive hint to the scope"),
  'apps/web/src/lib/ai/chat-pipeline/page-chat-turn.ts#runPageChatTurn': ceiling("narrows the agent's context drives and the owner's home-drive hint to the scope"),
  'apps/web/src/lib/ai/chat-pipeline/page-chat-turn.ts#runResult.buildStreamText': AI_CONTEXT,
  'apps/web/src/lib/ai/tools/actor-permissions.ts#isMcpScoped': PREDICATE,
  'apps/web/src/lib/ai/tools/actor-permissions.ts#driveOutsideMcpScope': ceiling('refuses a drive outside the scope'),
  'apps/web/src/lib/ai/tools/actor-permissions.ts#filterDriveIdsByMcpScope': ceiling('narrows a drive list the owner already reaches'),
  'apps/web/src/lib/ai/tools/actor-permissions.ts#pageOutsideMcpScope': ceiling("refuses a page whose drive is outside the scope"),
  'apps/web/src/lib/ai/tools/http-request-tools.ts#list_accounts.execute': AGENT_ACCOUNTS,
  'apps/web/src/lib/ai/tools/http-request-tools.ts#http_request.execute': AGENT_ACCOUNTS,
  'apps/web/src/lib/ai/tools/session-tools.ts#withinCredentialScope': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools.ts#readDispatchScope': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools.ts#spawn_session.execute': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools.ts#rename_workspace.execute': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools-runtime.ts#dispatchThroughChatPipeline': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools-runtime.ts#resolveWorkerPlacement': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools-runtime.ts#renameWorkspace': AGENT_RUNTIME,
  'apps/web/src/lib/ai/tools/session-tools-runtime.ts#createWorkerSession': AGENT_RUNTIME,
  'packages/lib/src/agent-accounts/account-authority-executor.ts#listAccounts': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/account-authority-executor.ts#requestOperation': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/build-audit-record.ts#buildAuditRecord': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/encode-grant.ts#encodeGrant': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/parse-grant.ts#parseGrant': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/verify-grant.ts#verifyGrant': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/executor/expected-binding-for.ts#expectedBindingFor': AGENT_ACCOUNTS,
  'packages/lib/src/agent-accounts/executor/http-request-executor.ts#execute': AGENT_ACCOUNTS,
  'packages/lib/src/permissions/decide-account-access.ts#decideAccountAccess': AGENT_ACCOUNTS,
  // ── revocation bookkeeping and the lapse guard ──────────────────────────────────────────────────────────
  'packages/lib/src/organizations/leave.ts#revokeOrgDriveGrantsForMembers': notAccess('selects the key rows a leave REVOKES'),
  'packages/lib/src/permissions/guest-holds.ts#tokenOutsiders': notAccess('finds outsider key rows to put on hold (removal), never grants'),
  'packages/lib/src/permissions/guest-holds.ts#takeOutsider': notAccess("takes an outsider's key rows off the drive for a hold"),
  'packages/lib/src/permissions/org-lapse-guard.ts#snapshotDriveAccess': notAccess("the lapse guard's before/after snapshot of who reaches the drive"),
};

const ROOTS = ['apps', 'packages/lib/src'];

function allReads(): ScopeRead[] {
  return listSourceFiles(ROOTS).flatMap((file) => scanScopeReadsInFile(file));
}

/** Code of `file#fn`, comments stripped. */
function code(file: string, fn: string): string {
  const text = functionText(file, fn);
  if (text === null) throw new Error(`${file}#${fn} not found`);
  return stripComments(text);
}

/** Every function in `file` that references `name` (by identifier), by ledger name. */
function referencersOf(file: string, name: string): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && !(node.parent && ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
      const fn = enclosingFunction(node);
      out.add(fn ? (functionName(fn) ?? '<anonymous>') : '<module>');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...out];
}

describe('key-scope reads: no key reaches past its owner (review #2849 r6)', () => {
  const reads = allReads();
  const keys = new Set(reads.map((r) => `${r.file}#${r.fn}`));

  it('every read of a key\'s drive scope sits in a ledgered function', () => {
    const unledgered = reads.filter((r) => !(`${r.file}#${r.fn}` in KEY_SCOPE_READ_LEDGER)).map((r) => `${r.file}:${r.line} ${r.fn} ${r.what}`);
    expect(unledgered, 'a NEW reader of a key\'s drive scope: route it through an owner-bound helper (OWNER_BOUND), or ledger why it only narrows').toEqual([]);
  });

  it('the ledger names only functions that still read the scope', () => {
    expect(Object.keys(KEY_SCOPE_READ_LEDGER).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every owner-bound helper calls its owner check', () => {
    const missing = Object.entries(OWNER_BOUND).flatMap(([fn, { file, calls }]) =>
      calls.filter((call) => !new RegExp(`\\b${call}\\s*\\(`).test(code(file, fn))).map((call) => `${file}#${fn} no longer calls ${call}`),
    );
    expect(missing).toEqual([]);
  });

  it('every `gated` function decides through an owner-bound helper; every `owner-bound` entry is one', () => {
    const bad = Object.entries(KEY_SCOPE_READ_LEDGER).flatMap(([key, verdict]) => {
      const [file, fn] = key.split('#') as [string, string];
      if (verdict.kind === 'gated' && !OWNER_BOUND_CALL.test(code(file, fn))) return [`${key}: gated but calls no owner-bound helper`];
      if (verdict.kind === 'owner-bound' && !(fn in OWNER_BOUND && OWNER_BOUND[fn].file === file)) return [`${key}: not in OWNER_BOUND`];
      return [];
    });
    expect(bad).toEqual([]);
  });

  it('the `primitive` row read is called only from inside the owner-bound helpers', () => {
    const bad = Object.entries(KEY_SCOPE_READ_LEDGER).flatMap(([key, verdict]) => {
      if (verdict.kind !== 'primitive') return [];
      const [file, fn] = key.split('#') as [string, string];
      return referencersOf(file, fn).filter((caller) => caller !== fn && !(caller in OWNER_BOUND)).map((caller) => `${key} called from ${caller}`);
    });
    expect(bad).toEqual([]);
  });

  it('every ceiling and not-access verdict carries its reason', () => {
    const bare = Object.entries(KEY_SCOPE_READ_LEDGER).filter(([, v]) => (v.kind === 'ceiling' || v.kind === 'not-access') && v.why.trim().length < 20);
    expect(bare).toEqual([]);
  });

  it('the scanner sees each kind of read (so the guard cannot pass by seeing nothing)', () => {
    const found = scanScopeReads(
      'x.ts',
      [
        'async function a() { return db.select().from(mcpTokenDrives); }',
        'async function b() { return db.query.mcpTokenDrives.findMany(); }',
        'async function c() { return db.query.mcpTokens.findFirst({ with: { driveScopes: true } }); }',
        'function d(auth) { return auth.allowedDriveIds; }',
        'function e(auth) { const { driveScopes } = auth; return driveScopes; }',
        'function f(ctx) { return ctx.mcpAllowedDriveIds; }',
        'function g(auth) { return getAllowedDriveIds(auth); }',
        'async function h() { return sql`select * from mcp_token_drives`; }',
        'function i(x) { x.allowedDriveIds = []; return { allowedDriveIds: [] }; }',
        'async function j() { await db.delete(mcpTokenDrives); await db.insert(mcpTokenDrives).values({}); }',
      ].join('\n'),
    );
    expect(found.map((r) => `${r.fn} ${r.what}`)).toEqual([
      'a from(mcpTokenDrives)',
      'b query.mcpTokenDrives',
      'c with: { driveScopes }',
      'd .allowedDriveIds',
      'e { driveScopes }',
      'f .mcpAllowedDriveIds',
      'g getAllowedDriveIds()',
      'h raw sql',
    ]);
  });
});
