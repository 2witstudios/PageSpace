/**
 * OAuth 2.1 scope grammar — parse, narrow, serialize.
 *
 * Implements ADR 0002 (`docs/adr/0002-oauth-scope-grammar.md`) Decisions 1-2
 * exactly. Pure functions only: no DB, no clock, no randomness. Every branch
 * fails closed — an unrecognized or ambiguous scope is rejected outright,
 * never silently dropped or partially granted.
 *
 * @module @pagespace/lib/auth/oauth/scopes
 */

const RESOURCE_ID_RE = /^[a-z0-9]{1,32}$/;

export type ParsedScope =
  | { kind: 'account' }
  | { kind: 'offline_access' }
  | { kind: 'manage_keys' }
  | {
      kind: 'drive';
      driveId: string;
      role: { kind: 'inherit' } | { kind: 'admin' } | { kind: 'member' } | { kind: 'custom'; customRoleId: string };
    };

export type ScopeSet = {
  account: boolean;
  offlineAccess: boolean;
  drives: ReadonlyMap<string, ParsedScope & { kind: 'drive' }>;
  // Grants key-management access with zero content access. Mutually exclusive
  // with `account` and any `drive:*` scope (see the manage_keys_conflict
  // check below); downstream fail-closed checks live in
  // apps/web/src/lib/auth/index.ts.
  manageKeys: boolean;
};

export type ScopeError =
  | { code: 'malformed_scope'; scope: string }
  | { code: 'unknown_scope'; scope: string }
  | { code: 'empty_scope' }
  | { code: 'account_drive_conflict' }
  | { code: 'manage_keys_conflict' }
  | { code: 'duplicate_drive'; driveId: string }
  | { code: 'offline_access_alone' };

export type DriveScopeRow = { driveId: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId: string | null };

export type GrantAuthority = ReadonlyMap<
  string,
  {
    isOwner: boolean;
    isMember: boolean;
    isAdmin: boolean;
    ownCustomRoleId: string | null;
    roleBelongsToDrive: (roleId: string) => boolean;
  }
>;

export type GrantAuthorityResult =
  | { ok: true }
  | { ok: false; reason: 'no_access' | 'admin_not_grantable' | 'foreign_custom_role' | 'custom_role_not_in_drive'; driveId: string };

function parseDriveScope(token: string): (ParsedScope & { kind: 'drive' }) | null {
  const parts = token.split(':');
  const driveId = parts[1];
  if (driveId === undefined || !RESOURCE_ID_RE.test(driveId)) return null;

  if (parts.length === 2) {
    return { kind: 'drive', driveId, role: { kind: 'inherit' } };
  }
  if (parts.length === 3 && parts[2] === 'admin') {
    return { kind: 'drive', driveId, role: { kind: 'admin' } };
  }
  if (parts.length === 3 && parts[2] === 'member') {
    return { kind: 'drive', driveId, role: { kind: 'member' } };
  }
  if (parts.length === 4 && parts[2] === 'role') {
    const customRoleId = parts[3];
    if (!RESOURCE_ID_RE.test(customRoleId)) return null;
    return { kind: 'drive', driveId, role: { kind: 'custom', customRoleId } };
  }
  return null;
}

/** Grammar (Decision 1). Total: never throws. */
export function parseScopeList(raw: string): { ok: true; scopes: ScopeSet } | { ok: false; error: ScopeError } {
  if (raw.trim().length === 0) {
    return { ok: false, error: { code: 'empty_scope' } };
  }

  const tokens = raw.split(' ');
  if (tokens.some((token) => token.length === 0)) {
    return { ok: false, error: { code: 'malformed_scope', scope: raw } };
  }

  let account = false;
  let offlineAccess = false;
  let manageKeys = false;
  const drives = new Map<string, ParsedScope & { kind: 'drive' }>();

  for (const token of tokens) {
    if (token === 'account') {
      account = true;
      continue;
    }
    if (token === 'offline_access') {
      offlineAccess = true;
      continue;
    }
    if (token === 'manage_keys') {
      manageKeys = true;
      continue;
    }
    if (token.startsWith('drive:')) {
      const parsed = parseDriveScope(token);
      if (!parsed) {
        return { ok: false, error: { code: 'malformed_scope', scope: token } };
      }
      if (drives.has(parsed.driveId)) {
        return { ok: false, error: { code: 'duplicate_drive', driveId: parsed.driveId } };
      }
      drives.set(parsed.driveId, parsed);
      continue;
    }
    return { ok: false, error: { code: 'unknown_scope', scope: token } };
  }

  if (account && drives.size > 0) {
    return { ok: false, error: { code: 'account_drive_conflict' } };
  }

  // manage_keys grants key-management access with zero content access — mixing
  // it with any content-access scope (account or drive:*) is ambiguous,
  // mirroring the account/drive exclusion above.
  if (manageKeys && (account || drives.size > 0)) {
    return { ok: false, error: { code: 'manage_keys_conflict' } };
  }

  // Rule 10: offline_access alone has no principal shape (Decision 2) — a
  // refresh token minted for it could only ever mint access tokens with no
  // access scope. Reject rather than grant a token that is structurally
  // useless (fail closed, Codex #1754). manage_keys is its own principal
  // shape, so offline_access + manage_keys is a valid, expected combination
  // (a long-lived key-management session).
  if (offlineAccess && !account && !manageKeys && drives.size === 0) {
    return { ok: false, error: { code: 'offline_access_alone' } };
  }

  return { ok: true, scopes: { account, offlineAccess, drives, manageKeys } };
}

function formatDriveScope(scope: ParsedScope & { kind: 'drive' }): string {
  switch (scope.role.kind) {
    case 'inherit':
      return `drive:${scope.driveId}`;
    case 'admin':
      return `drive:${scope.driveId}:admin`;
    case 'member':
      return `drive:${scope.driveId}:member`;
    case 'custom':
      return `drive:${scope.driveId}:role:${scope.role.customRoleId}`;
  }
}

/** Canonical serialization; parse(format(s)) deep-equals s (rule 9). */
export function formatScopeSet(scopes: ScopeSet): string {
  const tokens: string[] = [];
  if (scopes.account) tokens.push('account');
  if (scopes.manageKeys) tokens.push('manage_keys');
  if (scopes.offlineAccess) tokens.push('offline_access');

  const sortedDriveIds = [...scopes.drives.keys()].sort();
  for (const driveId of sortedDriveIds) {
    const scope = scopes.drives.get(driveId);
    if (scope) tokens.push(formatDriveScope(scope));
  }

  return tokens.join(' ');
}

function roleEquals(
  a: (ParsedScope & { kind: 'drive' })['role'],
  b: (ParsedScope & { kind: 'drive' })['role'],
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'custom' && b.kind === 'custom') return a.customRoleId === b.customRoleId;
  return true;
}

/**
 * Narrowing (rule 8): true iff requested ⊆ granted. account ⊄ any drive
 * set; drive:X:admin ⊄ drive:X:member; etc. Per-drive comparison is exact
 * match only — there is no cross-role privilege ordering asserted by the
 * grammar, so anything short of an identical role is treated as escalation
 * and rejected (fail closed).
 */
export function isScopeSubset(requested: ScopeSet, granted: ScopeSet): boolean {
  if (requested.offlineAccess && !granted.offlineAccess) return false;
  // manage_keys is never combined with account or drive:* (parse-time exclusion),
  // so it never reaches the account/drive narrowing checks below — its own
  // granted-bit check is the whole story.
  if (requested.manageKeys && !granted.manageKeys) return false;

  if (requested.account) {
    return granted.account;
  }

  if (granted.account) return true;

  for (const [driveId, requestedScope] of requested.drives) {
    const grantedScope = granted.drives.get(driveId);
    if (!grantedScope) return false;
    if (!roleEquals(requestedScope.role, grantedScope.role)) return false;
  }

  return true;
}

/** Bridge to the capability model: rows in mcp_token_drives shape (Decision 2). */
export function scopeSetToDriveScopes(scopes: ScopeSet): DriveScopeRow[] {
  const sortedDriveIds = [...scopes.drives.keys()].sort();
  const rows: DriveScopeRow[] = [];

  for (const driveId of sortedDriveIds) {
    const scope = scopes.drives.get(driveId);
    if (!scope) continue;

    switch (scope.role.kind) {
      case 'inherit':
        rows.push({ driveId, role: null, customRoleId: null });
        break;
      case 'admin':
        rows.push({ driveId, role: 'ADMIN', customRoleId: null });
        break;
      case 'member':
        rows.push({ driveId, role: 'MEMBER', customRoleId: null });
        break;
      case 'custom':
        // Rule 6: custom role implies MEMBER.
        rows.push({ driveId, role: 'MEMBER', customRoleId: scope.role.customRoleId });
        break;
    }
  }

  return rows;
}

/**
 * Consent-time authority check (Decision 2, mirrors mcp-tokens/route.ts:44-98).
 * Caller fetches access facts; the decision itself is pure. Rejects the
 * entire grant at the first offending drive (Decision 2: "any violation
 * rejects the entire authorization request").
 */
export function checkGrantAuthority(scopes: ScopeSet, authority: GrantAuthority): GrantAuthorityResult {
  for (const [driveId, scope] of scopes.drives) {
    const auth = authority.get(driveId);
    if (!auth || (!auth.isOwner && !auth.isMember)) {
      return { ok: false, reason: 'no_access', driveId };
    }

    if (scope.role.kind === 'admin' && !auth.isOwner && !auth.isAdmin) {
      return { ok: false, reason: 'admin_not_grantable', driveId };
    }

    if (scope.role.kind === 'custom') {
      if (!auth.roleBelongsToDrive(scope.role.customRoleId)) {
        return { ok: false, reason: 'custom_role_not_in_drive', driveId };
      }
      if (!auth.isOwner && !auth.isAdmin && auth.ownCustomRoleId !== scope.role.customRoleId) {
        return { ok: false, reason: 'foreign_custom_role', driveId };
      }
    }
  }

  return { ok: true };
}
