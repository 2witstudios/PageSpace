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
const NAME_CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

export type ParsedScope =
  | { kind: 'account' }
  | { kind: 'offline_access' }
  | { kind: 'manage_keys' }
  | { kind: 'all_drives' }
  | { kind: 'update_key'; tokenId: string }
  | { kind: 'activate_key'; tokenId: string }
  | { kind: 'name'; name: string }
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
  // Unrestricted access to every drive the granting user owns, including ones
  // created later — the CLI/wizard equivalent of the web Settings > MCP "Clear
  // selection (allow all drives)" key. Mutually exclusive with `account`,
  // `manageKeys`, any `drive:*` scope, and `update_key:*`/`activate_key:*` (see
  // the all_drives_conflict check below); may combine with `offlineAccess`.
  // Resolves to an unscoped (`isScoped: false`, zero drive rows) mcp_tokens
  // row via `isAllDrivesGrant` at token-issuance time — same treatment as
  // `isPureDriveGrant`, just with no drive rows instead of a scoped set.
  allDrives: boolean;
  // `update_key:<tokenId>` — this authorization request grants nothing new;
  // it re-scopes the caller's EXISTING mcp_* token (same secret) to exactly
  // the drive:* set alongside it. Riding inside the scope string (rather
  // than a separate authorize param) deliberately puts the target token id
  // under everything that already binds `scope`: the consent step-up
  // grant's action binding, the stored authorization-code row, and PKCE.
  // Mutually exclusive with `account`/`manage_keys` (nothing but drives can
  // be granted to an mcp token) and with `offline_access` (no refreshable
  // credential is minted by this grant); requires ≥1 drive:* scope (an
  // empty re-scope is what revocation is for).
  updateKeyId: string | null;
  // `activate_key:<tokenId>` — this authorization request grants NOTHING and
  // changes NOTHING server-side; it is a human-in-a-browser approval that the
  // requesting device may set the caller's EXISTING key as its ambient
  // default (`pagespace keys use`). Same in-scope-string rationale as
  // update_key above. Must be the ONLY scope in the request: it carries no
  // drives (the key's scope is untouched), mints nothing refreshable, and
  // combining it with any grant would let an "activate" consent screen
  // smuggle a real grant.
  activateKeyId: string | null;
  // `name:<percent-encoded-utf8>` — the user-chosen name for the `mcp_tokens`
  // row this grant mints. Carries no capability itself; FORBIDDEN on any
  // grant shape that doesn't mint a NEW `mcp_tokens` row (`account`/
  // `manage_keys`/`update_key`/`activate_key` — attaching a name there would
  // either be meaningless, since no row is minted, or spoof a "creating a
  // key" consent line when no key is actually being created), enforced by
  // this parser's `name_without_mint_grant` rule below. Deliberately NOT
  // enforced as *required* on a mint-shaped grant (pure `drive:*`/
  // `all_drives`) at this layer — this parser is reused by flows (e.g.
  // device-authorization's plain OAuth token pairs) that never mint an
  // `mcp_tokens` row and legitimately carry no name. The "mint-shaped grant
  // requires a name" half is enforced at `validateAuthorizeRequest`
  // (`authorize-request.ts`), the one call site whose result actually reaches
  // a real mint.
  newKeyName: string | null;
};

export type ScopeError =
  | { code: 'malformed_scope'; scope: string }
  | { code: 'unknown_scope'; scope: string }
  | { code: 'empty_scope' }
  | { code: 'account_drive_conflict' }
  | { code: 'manage_keys_conflict' }
  | { code: 'all_drives_conflict' }
  | { code: 'duplicate_drive'; driveId: string }
  | { code: 'offline_access_alone' }
  | { code: 'duplicate_update_key' }
  | { code: 'update_key_conflict' }
  | { code: 'update_key_without_drive' }
  | { code: 'duplicate_activate_key' }
  | { code: 'activate_key_not_alone' }
  | { code: 'duplicate_name' }
  | { code: 'malformed_name' }
  | { code: 'name_without_mint_grant' };

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
  let allDrives = false;
  let updateKeyId: string | null = null;
  let activateKeyId: string | null = null;
  let newKeyName: string | null = null;
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
    if (token === 'all_drives') {
      allDrives = true;
      continue;
    }
    if (token.startsWith('update_key:')) {
      const tokenId = token.slice('update_key:'.length);
      if (!RESOURCE_ID_RE.test(tokenId)) {
        return { ok: false, error: { code: 'malformed_scope', scope: token } };
      }
      if (updateKeyId !== null) {
        return { ok: false, error: { code: 'duplicate_update_key' } };
      }
      updateKeyId = tokenId;
      continue;
    }
    if (token.startsWith('activate_key:')) {
      const tokenId = token.slice('activate_key:'.length);
      if (!RESOURCE_ID_RE.test(tokenId)) {
        return { ok: false, error: { code: 'malformed_scope', scope: token } };
      }
      if (activateKeyId !== null) {
        return { ok: false, error: { code: 'duplicate_activate_key' } };
      }
      activateKeyId = tokenId;
      continue;
    }
    if (token.startsWith('name:')) {
      if (newKeyName !== null) {
        return { ok: false, error: { code: 'duplicate_name' } };
      }
      const encoded = token.slice('name:'.length);
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        return { ok: false, error: { code: 'malformed_name' } };
      }
      if (decoded.length === 0 || decoded.length > 100 || NAME_CONTROL_CHAR_RE.test(decoded)) {
        return { ok: false, error: { code: 'malformed_name' } };
      }
      newKeyName = decoded;
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

  // all_drives is its own principal shape (unrestricted, but drive-scoped —
  // distinct from account's full-user grant and from manage_keys' zero
  // content access), so mixing it with any of them, or with a specific
  // drive:* set, is ambiguous the same way rule 3/11 reject those pairings.
  if (allDrives && (account || manageKeys || drives.size > 0)) {
    return { ok: false, error: { code: 'all_drives_conflict' } };
  }

  // activate_key is a pure approval ceremony — it grants nothing, so ANY
  // other scope alongside it (including update_key or another grant) would
  // let a consent screen narrating "activate" carry a real grant. Sole-scope
  // or rejected, checked before the update_key/offline_access rules so its
  // error shape is its own.
  if (
    activateKeyId !== null &&
    (account || manageKeys || allDrives || offlineAccess || updateKeyId !== null || drives.size > 0)
  ) {
    return { ok: false, error: { code: 'activate_key_not_alone' } };
  }

  // Ordered BEFORE the offline_access_alone check below so update_key error
  // precedence is explicit in code order and that check keeps its original
  // shape (no update_key conjunct grafted on).
  if (updateKeyId !== null) {
    // Nothing but drives can be attached to an mcp token, and this grant
    // mints nothing refreshable — offline_access alongside it would promise
    // a refresh credential that structurally cannot exist.
    if (account || manageKeys || allDrives || offlineAccess) {
      return { ok: false, error: { code: 'update_key_conflict' } };
    }
    // Re-scoping to zero drives is "disable the key" — that's revocation's
    // job, and silently granting it here would let a consent screen that
    // narrates "update access" strip a key instead.
    if (drives.size === 0) {
      return { ok: false, error: { code: 'update_key_without_drive' } };
    }
  }

  // Rule 10: offline_access alone has no principal shape (Decision 2) — a
  // refresh token minted for it could only ever mint access tokens with no
  // access scope. Reject rather than grant a token that is structurally
  // useless (fail closed, Codex #1754). manage_keys and all_drives are each
  // their own principal shape, so offline_access + manage_keys or
  // offline_access + all_drives is a valid, expected combination (a
  // long-lived key-management or all-drives session).
  if (offlineAccess && !account && !manageKeys && !allDrives && drives.size === 0) {
    return { ok: false, error: { code: 'offline_access_alone' } };
  }

  // name_without_mint_grant: `name:*` only means something on a grant that mints a NEW
  // mcp_tokens row (a pure drive:* set or all_drives). Every other shape either has no row
  // to name (account/manage_keys) or explicitly changes nothing (update_key/activate_key).
  // Reject rather than silently drop it or let a consent line imply a new key when none is minted.
  //
  // Deliberately NOT enforcing "a mint-shaped grant REQUIRES a name" here, even though that's
  // the actual CLI bug this field exists to fix — this parser is reused far beyond the CLI's
  // mint path (the device-authorization flow's plain drive:*/all_drives grants never mint an
  // mcp_tokens row at all — they resolve to an ordinary OAuth access/refresh pair — and stored
  // `oauth_access_tokens` rows from that flow are re-parsed here on every authenticated request
  // for schema validation). A name-required rule at this level would incorrectly reject those.
  // The requirement is enforced instead at the one call site that actually mints from this shape:
  // `POST /api/oauth/authorize`'s consent decision (`hasNewKeyName` check, mirroring its
  // update_key/activate_key ownership gates) — see that route for the real enforcement.
  if (newKeyName !== null && !((allDrives || drives.size > 0) && updateKeyId === null && activateKeyId === null)) {
    return { ok: false, error: { code: 'name_without_mint_grant' } };
  }

  return {
    ok: true,
    scopes: { account, offlineAccess, drives, manageKeys, allDrives, updateKeyId, activateKeyId, newKeyName },
  };
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
  if (scopes.activateKeyId !== null) tokens.push(`activate_key:${scopes.activateKeyId}`);
  if (scopes.updateKeyId !== null) tokens.push(`update_key:${scopes.updateKeyId}`);
  if (scopes.newKeyName !== null) tokens.push(`name:${encodeURIComponent(scopes.newKeyName)}`);
  if (scopes.account) tokens.push('account');
  if (scopes.allDrives) tokens.push('all_drives');
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

  // Same treatment as manage_keys: all_drives is its own principal shape,
  // never combined with account or drive:* (parse-time exclusion), so its own
  // granted-bit check is the whole story — a granted `account` does not
  // implicitly satisfy a requested `all_drives` (fail closed, no cross-shape
  // narrowing asserted by the grammar).
  if (requested.allDrives && !granted.allDrives) return false;

  // update_key/activate_key never survive narrowing: each exists only inside
  // a single consent-bound authorization code, so any request carrying one
  // against a grant that doesn't carry the identical one (e.g. a
  // refresh-token grant trying to smuggle a key re-scope or activation in)
  // is escalation, rejected outright.
  if (requested.updateKeyId !== null && requested.updateKeyId !== granted.updateKeyId) return false;
  if (requested.activateKeyId !== null && requested.activateKeyId !== granted.activateKeyId) return false;

  // Effectively dead code today (mint-shaped grants never reach a persisted refresh/access
  // token that gets subset-checked later), but kept for the invariant that every ScopeSet
  // field is compared here, never silently ignored.
  if (requested.newKeyName !== granted.newKeyName) return false;

  if (requested.account) {
    return granted.account;
  }

  if (granted.account) return true;

  // Symmetric with the `granted.account` case above: `all_drives` is
  // documented (ADR 0002) as "the maximum grant for a drive-scoped key" — a
  // granted `all_drives` covers any requested `drive:*` subset the exact
  // same way a granted `account` does. (A requested `all_drives` was already
  // resolved by the `requested.allDrives` check above and never reaches this
  // line unless `granted.allDrives` is also true, so this only ever narrows
  // a plain drive:* request here — not a second, redundant path for the
  // all_drives-vs-all_drives case.)
  if (granted.allDrives) return true;

  for (const [driveId, requestedScope] of requested.drives) {
    const grantedScope = granted.drives.get(driveId);
    if (!grantedScope) return false;
    if (!roleEquals(requestedScope.role, grantedScope.role)) return false;
  }

  return true;
}

/**
 * True iff this grant is a pure content-access grant — one or more `drive:*`
 * scopes and nothing else (no `account`, no `manage_keys`). Parse-time
 * exclusion already guarantees `account`/`manageKeys`/`drives` are mutually
 * exclusive (see `parseScopeList` above), so this is just the "has drives"
 * case named for callers that need to branch on it (e.g. OAuth token
 * issuance minting a real `mcp_tokens` row instead of an OAuth grant for
 * this shape specifically).
 */
export function isPureDriveGrant(scopes: ScopeSet): boolean {
  return !scopes.account && !scopes.manageKeys && scopes.drives.size > 0 && scopes.updateKeyId === null && scopes.activateKeyId === null;
}

/**
 * True iff this grant is the `all_drives` shape — unrestricted access to
 * every drive the granting user owns, including ones created later. Parse-time
 * exclusion already guarantees `account`/`manageKeys`/`drives`/`updateKeyId`/
 * `activateKeyId` are all empty whenever this is true (see `parseScopeList`
 * above), so this is just the "has the allDrives flag" case named for callers
 * that need to branch on it — the token-issuance sibling of `isPureDriveGrant`:
 * both mint a real `mcp_tokens` row instead of an OAuth refresh/access-token
 * pair, but this shape mints it `isScoped: false` with zero drive rows
 * instead of the drive-scoped set `isPureDriveGrant` produces.
 */
export function isAllDrivesGrant(scopes: ScopeSet): boolean {
  return scopes.allDrives;
}

/**
 * True iff this grant re-scopes an existing mcp token in place
 * (`update_key:<id>` + ≥1 `drive:*`, the only shape parse admits for
 * `updateKeyId`). The token-issuance sibling of `isPureDriveGrant`: that
 * shape mints a NEW `mcp_tokens` row, this one replaces the drive-scope rows
 * of an existing row and never touches its secret. A type predicate, so
 * callers get `updateKeyId: string` narrowing instead of re-checking the
 * field themselves.
 */
export function isKeyUpdateGrant(scopes: ScopeSet): scopes is ScopeSet & { updateKeyId: string } {
  return scopes.updateKeyId !== null;
}

/**
 * True iff this grant is a pure activation ceremony (`activate_key:<id>`
 * alone, the only shape parse admits for `activateKeyId`). Grants nothing
 * and changes nothing server-side: token issuance verifies ownership and
 * returns a PKCE-verified success signal so the requesting device may set
 * the key as its ambient default (`pagespace keys use`). A type predicate,
 * mirroring `isKeyUpdateGrant`.
 */
export function isKeyActivationGrant(scopes: ScopeSet): scopes is ScopeSet & { activateKeyId: string } {
  return scopes.activateKeyId !== null;
}

/**
 * True iff this grant carries a user-chosen name for the `mcp_tokens` row it
 * mints. A type predicate, mirroring `isKeyUpdateGrant`/`isKeyActivationGrant`.
 */
export function hasNewKeyName(scopes: ScopeSet): scopes is ScopeSet & { newKeyName: string } {
  return scopes.newKeyName !== null;
}

/**
 * True iff approving this grant escalates the approver's credentials — it
 * mints a key (`name:`), re-scopes one (`update_key:`), or makes one a
 * device's ambient default (`activate_key:`) — as opposed to merely
 * establishing a login session.
 *
 * Exists so the two halves of the device-flow step-up gate cannot drift: the
 * `/activate` verify route uses it to decide whether to advertise (and run)
 * the second-factor ceremony, and the decision route uses it to decide whether
 * to REQUIRE one. Two independent expressions of that rule would mean a fourth
 * key-shaped scope could be added where the screen never runs the ceremony and
 * the server then rejects a legitimate approval — or, worse, where the server
 * stops demanding one.
 *
 * The loopback consent screen does not need this: `/api/oauth/authorize`
 * requires step-up for EVERY consent, escalating or not.
 */
export function isCredentialEscalatingGrant(scopes: ScopeSet): boolean {
  return hasNewKeyName(scopes) || isKeyUpdateGrant(scopes) || isKeyActivationGrant(scopes);
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
