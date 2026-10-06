/**
 * Seam guard: review #2849 r6. No key reaches past its owner, by any reader of the key's drive scope.
 *
 * Reviews r4, r5 and r6 each found one more reader that took a key's drive scope (its `mcp_token_drives` rows, the
 * stored OAuth grant, or the scope on the authenticated principal) as membership without asking whether the key's
 * OWNER is still a member of the drive. This test finds EVERY read of that scope in the tree (key-scope-read-scan.ts) and requires the
 * function it sits in to be in the ledger below with one of five verdicts:
 *
 *   - `owner-bound`: the function IS one of the owner-bound helpers (OWNER_BOUND below); each one is checked to call
 *     its owner check;
 *   - `gated`: it reads the scope and decides access only through an owner-bound helper (its code calls one);
 *   - `primitive`: the raw row read behind the owner-bound helpers, called only from inside them (checked);
 *   - `ceiling`: the scope only NARROWS what the owner already reaches, or refuses (the reason says how);
 *   - `not-access`: the read is not an access decision: authentication, token issuance, consent and grant display, key
 *     management or display, the scope grammar, revocation bookkeeping, the lapse guard's snapshot (the reason says
 *     which).
 *
 * Detection is by name (key-scope-read-scan.ts: tables, properties, accessors, through aliases, namespaces, holders)
 * AND by type (key-scope-typed-scan.ts: a ScopeSet's `drives`, an OAuth token row's `scopes`, whatever the variable is
 * called). Stated limits: a rest spread (`const { ...rest } = auth`) copies the scope without naming it (a later
 * `rest.allowedDriveIds` read is still seen); a renamed barrel re-export of a tracked function is not followed.
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
import { scanTypedScopeReads, scanTypedSource } from './key-scope-typed-scan';

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
const KEY_ADMIN = notAccess("session only: a drive lead or admin (checkDriveAccess, the caller's own live standing) managing a key's row in THEIR drive");
const KEY_LIST = notAccess("session only: a current drive member (checkDriveAccess) sees which keys hold a row in the drive, with their stored role; display, resolution is owner-bound");
const ISSUANCE = notAccess("token issuance: copies an approved, stored grant onto a token (a refresh may only narrow it: isScopeSubset); the token then resolves through the owner-bound helpers");
const CONSENT_DISPLAY = notAccess("consent / grant display: names the drives and roles a grant asks for or holds; grants nothing");
const SCOPE_GRAMMAR = notAccess('the OAuth scope grammar (parse, format, shape tests); grants nothing itself');
const CAPABILITY_SCOPES = notAccess("a session token's CAPABILITY scopes (e.g. mcp:*, env:bridge), not a key's drive scope: the type rule flags any scopes: string[] and fails closed");
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
  'apps/web/src/app/api/drives/[driveId]/apps/members/route.ts#GET': KEY_LIST,
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
  'apps/web/src/lib/repositories/session-repository.ts#run': notAccess(
    "the key's own mint / re-scope transaction. Settings routes bound the scope by validateDriveScopeAccess (the owner's live access, scopeWidensCaller); the OAuth path (applyKeyGrant) by checkGrantAuthority at consent, which is weaker (no scopeWidensCaller), and resolution intersects with the owner's current access either way",
  ),
  'apps/web/src/lib/repositories/oauth-repository.ts#toSessionRepoDrives': notAccess('shapes an approved key grant into key rows for the mint / re-scope above'),
  'apps/web/src/lib/repositories/oauth-repository.ts#applyKeyGrant': notAccess("mints or re-scopes the MCP key an approved grant names; the grant was authority-checked at consent and the key's rows resolve through owner-bound helpers"),
  // ── the OAuth grant (review r7): authentication, issuance, consent, grant-time authority ────────────────
  'apps/web/src/lib/auth/index.ts#validateOAuthAccessToken': notAccess(
    "authentication: parses the stored grant into the principal (driveScopes, allowedDriveIds); every decision reads them through this ledger",
  ),
  'apps/web/src/lib/repositories/oauth-repository.ts#exchangeAuthorizationCode': ISSUANCE,
  'apps/web/src/lib/repositories/oauth-repository.ts#refreshTokenGrant': ISSUANCE,
  'apps/web/src/lib/repositories/oauth-repository.ts#pollDeviceToken': ISSUANCE,
  'apps/web/src/lib/repositories/oauth-repository.ts#recordDeviceApproval': ISSUANCE,
  'apps/web/src/lib/repositories/oauth-repository.ts#verifyDeviceUserCode': CONSENT_DISPLAY,
  'apps/web/src/lib/repositories/oauth-repository.ts#listActiveOAuthGrantsForUser': CONSENT_DISPLAY,
  'apps/web/src/app/api/account/oauth-grants/route.ts#resolveScopeNames': CONSENT_DISPLAY,
  'apps/web/src/app/oauth/consent/page.tsx#ConsentPage': CONSENT_DISPLAY,
  'apps/web/src/app/api/oauth/device_authorization/verify/route.ts#POST': CONSENT_DISPLAY,
  'packages/lib/src/auth/oauth/grant-scope-summary.ts#describeGrantScopes': CONSENT_DISPLAY,
  'apps/web/src/app/api/account/oauth-grants/route.ts#GET': CONSENT_DISPLAY,
  'apps/web/src/app/api/oauth/token/route.ts#handleAuthorizationCodeGrant': ISSUANCE,
  'apps/web/src/app/api/oauth/token/route.ts#handleDeviceCodeGrant': ISSUANCE,
  'apps/web/src/app/api/oauth/token/route.ts#handleRefreshTokenGrant': ISSUANCE,
  'apps/web/src/app/api/oauth/token/route.ts#keyGrantSuccessResponse': ISSUANCE,
  'apps/web/src/lib/repositories/oauth-repository.ts#createAuthorizationCode': notAccess('stores the requested grant on an authorization code (the authorize route authority-checks it first: checkGrantAuthority)'),
  'apps/web/src/lib/repositories/oauth-repository.ts#createDeviceAuthorization': notAccess('stores the requested scope on a device code; approval is authority-checked later (device decision)'),
  'apps/web/src/lib/repositories/oauth-repository.ts#toDeviceCodeRecord': notAccess('shapes a device-code row for the lifecycle decisions below'),
  'packages/lib/src/auth/oauth/code-lifecycle.ts#decideCodeExchange': ISSUANCE,
  'packages/lib/src/auth/oauth/code-lifecycle.ts#decideDevicePoll': ISSUANCE,
  'packages/lib/src/auth/oauth/code-lifecycle.ts#decideDeviceApproval': ISSUANCE,
  'apps/web/src/app/api/mcp-ws/route.ts#UPGRADE': CAPABILITY_SCOPES,
  'apps/web/src/app/api/env-bridge/ws/route.ts#UPGRADE': CAPABILITY_SCOPES,
  'packages/lib/src/auth/session-service.ts#SessionService.createSession': CAPABILITY_SCOPES,
  'packages/lib/src/auth/session-service.ts#SessionService.validateSessionWithReason': CAPABILITY_SCOPES,
  'packages/lib/src/permissions/enforced-context.ts#EnforcedAuthContext.fromSession': CAPABILITY_SCOPES,
  'packages/lib/src/integrations/oauth/oauth-handler.ts#buildOAuthAuthorizationUrl': notAccess("a THIRD-PARTY provider's OAuth scopes (integrations), not a PageSpace key's"),
  'apps/web/src/app/api/oauth/device_authorization/route.ts#POST': notAccess('validates the requested scope string when a device code is issued; grants nothing'),
  'packages/lib/src/auth/oauth/authorize-request.ts#validateAuthorizeRequest': notAccess('validates the requested scope string of an authorize request; grants nothing'),
  'apps/web/src/app/api/oauth/device_authorization/decision/route.ts#POST': ceiling(
    "approval refuses any drive scope the approving user does not hold NOW (resolveGrantAuthority → checkGrantAuthority)",
  ),
  'apps/web/src/lib/auth/oauth-grant-authority.ts#resolveGrantAuthority': ceiling("reads the approving user's CURRENT standing on each requested drive (getDriveAccess)"),
  'packages/lib/src/auth/oauth/scopes.ts#checkGrantAuthority': ceiling('refuses a grant naming a drive (or role) the user does not hold now'),
  'packages/lib/src/auth/oauth/scopes.ts#isScopeSubset': ceiling('a refresh may only NARROW its grant: every requested drive scope must already be granted, same role'),
  'packages/lib/src/auth/oauth/scopes.ts#formatScopeSet': SCOPE_GRAMMAR,
  'packages/lib/src/auth/oauth/scopes.ts#isPureDriveGrant': SCOPE_GRAMMAR,
  'packages/lib/src/auth/oauth/scopes.ts#scopeSetToDriveScopes': SCOPE_GRAMMAR,
  // ── revocation bookkeeping and the lapse guard ──────────────────────────────────────────────────────────
  'apps/web/src/app/api/drives/[driveId]/members/[userId]/route.ts#DELETE': notAccess("deletes the removed member's own key rows in the drive"),
  'packages/lib/src/organizations/leave.ts#revokeOAuthFamiliesNamingDrives': notAccess('finds the OAuth grants a leave REVOKES'),
  'packages/lib/src/organizations/leave.ts#scopesNameDrive': notAccess('whether a stored grant names a drive, for the revocation above'),
  'packages/lib/src/permissions/guest-holds.ts#reinsertHeldAccess': notAccess("restores the key rows a guest hold removed when the hold is released; the rows resolve through owner-bound helpers"),
  'packages/lib/src/organizations/leave.ts#revokeOrgDriveGrantsForMembers': notAccess('selects the key rows a leave REVOKES'),
  'packages/lib/src/permissions/guest-holds.ts#tokenOutsiders': notAccess('finds outsider key rows to put on hold (removal), never grants'),
  'packages/lib/src/permissions/guest-holds.ts#takeOutsider': notAccess("takes an outsider's key rows off the drive for a hold"),
  'packages/lib/src/permissions/org-lapse-guard.ts#snapshotDriveAccess': notAccess("the lapse guard's before/after snapshot of who reaches the drive"),
};

const ROOTS = ['apps', 'packages/lib/src'];

/** Name-based reads over every file, plus the type-based reads (the checker's runtime is reported by a test below). */
function allReads(): { reads: ScopeRead[]; typedMs: number } {
  const files = listSourceFiles(ROOTS);
  const typed = scanTypedScopeReads(files);
  return { reads: [...files.flatMap((file) => scanScopeReadsInFile(file)), ...typed.reads], typedMs: typed.ms };
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
  const { reads, typedMs } = allReads();
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

  it('the scanner sees each kind of read, through aliases, namespaces, sql interpolation and brackets, and the OAuth store (so the guard cannot pass by seeing nothing)', () => {
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
        'function j(x) { const { userId } = x; return userId; }',
        "import { mcpTokenDrives as t, getAllowedDriveIds as g2 } from 'x'; async function k() { return db.select().from(t); }",
        'function l(auth) { return g2(auth); }',
        "import * as schema from 'y'; async function m() { return db.select().from(schema.mcpTokenDrives); }",
        'async function n() { return db.execute(sql`select drive_id from ${mcpTokenDrives}`); }',
        "function o(auth) { return auth['allowedDriveIds']; }",
        'function p(auth) { return auth.scopes.drives.has(1); }',
        "function q(parsed) { return parsed.scopes['drives']; }",
        'async function r() { return db.select({ s: oauthRefreshTokens.scopes }).from(oauthRefreshTokens); }',
        "function s(raw) { return parseScopeList(raw); }",
        'async function u() { await db.delete(mcpTokenDrives); }',
        'function v(auth) { const { drives: d } = (auth as unknown as { scopes: { drives: Map<string, string> } }).scopes; return d; }',
        'function w(auth) { const grant = (auth as unknown as { scopes: { drives: Map<string, string> } }).scopes; return grant.drives.has(1); }',
      ].join('\n'),
    );
    expect(found.map((r) => `${r.fn} ${r.what}`)).toEqual([
      'a mcpTokenDrives',
      'b .mcpTokenDrives',
      'c with: { driveScopes }',
      'd .allowedDriveIds',
      'e { driveScopes }',
      'f .mcpAllowedDriveIds',
      'g getAllowedDriveIds',
      'h raw sql',
      'k mcpTokenDrives',
      'l getAllowedDriveIds',
      'm .mcpTokenDrives',
      'n mcpTokenDrives',
      'o .allowedDriveIds',
      'p scopes.drives',
      'q scopes.drives',
      'r oauthRefreshTokens.scopes',
      's parseScopeList',
      'u mcpTokenDrives',
      'v { drives } of scopes',
      'w scopes.drives',
    ]);
  });
  it('the type-based scan resolves real types (a broken resolution, typing everything any, would see nothing and fail open)', () => {
    const typed = new Set(reads.filter((r) => r.what.endsWith('(typed)')).map((r) => `${r.file}#${r.fn}`));
    expect([
      'packages/lib/src/auth/oauth/scopes.ts#isScopeSubset', // a ScopeSet parameter
      'apps/web/src/lib/repositories/oauth-repository.ts#refreshTokenGrant', // a drizzle oauth_refresh_tokens row
      'apps/web/src/lib/auth/index.ts#validateOAuthAccessToken', // a hand-written record from @pagespace/lib
    ].filter((sentinel) => !typed.has(sentinel))).toEqual([]);
  });

  it('the type-based scan runs within budget (its runtime is printed)', () => {
    console.log(`key-scope typed scan: ${typedMs} ms`);
    expect(typedMs).toBeLessThan(120_000);
  });

  it('the type-based scan sees a ScopeSet and an OAuth row by TYPE, through renames the name rules cannot follow', () => {
    const found = scanTypedSource(
      'typed.ts',
      [
        'type Set1 = { account: boolean; manageKeys: boolean; drives: ReadonlyMap<string, unknown> };',
        'type Row = { id: string; clientId: string; scopes: string[] };',
        'type Rec = { id: string; scopes: string[]; expiresAt: Date };',
        'export function a(x: Set1) { return x.drives; }',
        'export function b(holder: { grant: Set1 }) { const g = holder.grant; return g.drives.size; }',
        'export function c(x: Set1) { const { drives } = x; return drives; }',
        "export function d(x: Set1 | null) { return x?.['drives']; }",
        'export function e(row: Row) { return row.scopes; }',
        'export function f(rec: Rec | undefined) { return rec?.scopes.length; }',
        'export function g(row: Row) { const { scopes } = row; return scopes; }',
        'export function h(other: { drives: string[]; scopes: number }) { return [other.drives, other.scopes]; }',
      ].join('\n'),
    );
    expect(found.map((r) => `${r.fn} ${r.what}`)).toEqual([
      'a ScopeSet.drives (typed)',
      'b ScopeSet.drives (typed)',
      'c ScopeSet.drives (typed)',
      'd ScopeSet.drives (typed)',
      'e oauth row.scopes (typed)',
      'f oauth row.scopes (typed)',
      'g oauth row.scopes (typed)',
    ]);
  });
});
