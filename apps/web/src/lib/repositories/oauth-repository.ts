/**
 * Repository for the OAuth 2.1 provider's persistence (Phase 1 tasks 6-7).
 * Isolates DB access from the /api/oauth/authorize and /api/oauth/token
 * route handlers.
 */

import { createId } from '@paralleldrive/cuid2';
import { OAUTH_ACCESS_TOKEN_PREFIX } from '@/lib/auth/token-prefixes';
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { oauthClients, oauthAuthorizationCodes, oauthRefreshTokens, oauthAccessTokens, oauthDeviceCodes } from '@pagespace/db/schema/oauth';
import { users } from '@pagespace/db/schema/auth';
import type { RegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { hashToken, generateToken } from '@pagespace/lib/auth/token-utils';
import { decideCodeExchange, type CodeExchangeDecision } from '@pagespace/lib/auth/oauth/code-lifecycle';
import {
  decideDevicePoll,
  decideDeviceApproval,
  type DeviceCodeRecord,
  type DeviceApprovalAction,
  type DeviceApprovalDecision,
} from '@pagespace/lib/auth/oauth/code-lifecycle';
import { issueInitialTokenPair, issueRotatedTokenPair, type IssuedTokenPair } from '@pagespace/lib/auth/oauth/issue-tokens';
import { decideRefreshRotation } from '@pagespace/lib/auth/oauth/refresh-rotation';
import { parseScopeList, isScopeSubset, formatScopeSet, isAllDrivesGrant, isKeyActivationGrant, isKeyUpdateGrant, isPureDriveGrant, hasNewKeyName, scopeSetToDriveScopes } from '@pagespace/lib/auth/oauth/scopes';
import { sessionRepository } from './session-repository';

/**
 * First-party clients are defined in code (the static registry), not the DB —
 * but `oauth_authorization_codes.clientId` is a foreign key into `oauth_clients`
 * (that table's job, per ADR 0002 Decision 3, is to also accommodate future
 * dynamically-registered clients). This ensures a matching row exists for a
 * static registry client, keyed by the stable `clientId` string, so the FK
 * resolves; the static registry — not this row — remains the source of truth
 * for redirect URIs, grants, and enablement.
 */
export async function ensureOAuthClientRow(client: RegisteredClient): Promise<string> {
  await db
    .insert(oauthClients)
    .values({
      clientId: client.clientId,
      name: client.name,
      clientType: client.type,
      redirectUris: client.redirectUris,
      isFirstParty: client.firstParty,
    })
    .onConflictDoNothing({ target: oauthClients.clientId });

  const row = await db.query.oauthClients.findFirst({
    where: eq(oauthClients.clientId, client.clientId),
    columns: { id: true },
  });

  if (!row) {
    throw new Error(`Failed to ensure OAuth client row for ${client.clientId}`);
  }

  return row.id;
}

export interface CreateAuthorizationCodeInput {
  clientDbId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
  codeHash: string;
  codePrefix: string;
  expiresAt: Date;
}

export async function createAuthorizationCode(input: CreateAuthorizationCodeInput): Promise<void> {
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: input.codeHash,
    codePrefix: input.codePrefix,
    clientId: input.clientDbId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
  });
}

export interface ExchangeAuthorizationCodeInput {
  /** Raw code from the token request; hashed before any lookup. */
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** Resolved `oauth_clients.id` for the request's client_id — the lookup
   * below is scoped to this, so a code issued to a different client is
   * indistinguishable from an unknown code (no oracle). */
  clientDbId: string;
  now: Date;
}

export type ExchangeAuthorizationCodeResult =
  | { outcome: 'not_found' }
  | { outcome: 'rejected'; decision: Exclude<CodeExchangeDecision, { status: 'ok' }> }
  | { outcome: 'user_suspended' }
  | { outcome: 'ok'; userId: string; scopes: string[]; tokens: IssuedTokenPair }
  | { outcome: 'ok_mcp_token'; userId: string; scopes: string[]; mcpToken: string }
  /** An `update_key` grant applied in place — no credential was minted, the target token's secret is unchanged. */
  | { outcome: 'ok_mcp_update'; userId: string; scopes: string[]; tokenId: string }
  /** The `update_key` target was revoked/deleted between consent and exchange — the route collapses this to the constant-shape invalid_grant. */
  | { outcome: 'update_target_gone' }
  /** An `activate_key` approval verified — nothing was minted or changed; the requesting device may set the key as its ambient default. */
  | { outcome: 'ok_mcp_activate'; userId: string; scopes: string[]; tokenId: string }
  /** The `activate_key` target was revoked/deleted between consent and exchange — collapsed to invalid_grant by the route. */
  | { outcome: 'activate_target_gone' };

/**
 * DriveScopeRow → the drive shape `sessionRepository`'s mcp-token writers
 * take. One helper for BOTH the fresh-mint (`ok_mcp_token`) and in-place
 * update (`ok_mcp_update`) branches — the `customRoleId ?? undefined`
 * null-vs-undefined coercion is load-bearing, and maintaining it twice would
 * let mint and update silently diverge on custom-role rows.
 */
function toSessionRepoDrives(scopes: Parameters<typeof scopeSetToDriveScopes>[0]) {
  return scopeSetToDriveScopes(scopes).map(({ driveId, role, customRoleId }) => ({
    id: driveId,
    role,
    customRoleId: customRoleId ?? undefined,
  }));
}

/**
 * What a key-shaped grant DID, independent of which OAuth flow carried it.
 * `not_a_key_grant` means the scope set is an ordinary login grant and the
 * caller should fall through to minting an OAuth access/refresh pair.
 */
export type KeyGrantResult =
  | { outcome: 'ok_mcp_token'; mcpToken: string }
  | { outcome: 'ok_mcp_update'; tokenId: string }
  | { outcome: 'ok_mcp_activate'; tokenId: string }
  | { outcome: 'update_target_gone' }
  | { outcome: 'activate_target_gone' }
  | { outcome: 'not_a_key_grant' };

/**
 * Applies a consented, key-shaped grant — mint (`drive:*`/`all_drives`),
 * re-scope in place (`update_key:<id>`), or approve activation
 * (`activate_key:<id>`) — inside the caller's transaction.
 *
 * Extracted from `exchangeAuthorizationCode` so the RFC 8628 device flow
 * (`pollDeviceToken`) applies grants through the SAME code rather than a
 * parallel implementation: these branches decide what credential material a
 * human's consent actually produces, and two copies would be two places for
 * mint-vs-update semantics, ownership re-verification, or the `isScoped`
 * flag to drift apart.
 *
 * What this function deliberately does NOT do is any per-flow bookkeeping:
 * consuming the authorization code, persisting `lastPolledAt`, or checking
 * user suspension all stay with the caller, which is the only party that
 * knows what row it is holding. Callers MUST perform their own
 * single-use bookkeeping for every outcome except `not_a_key_grant`,
 * including the two `*_target_gone` failures — those fail closed by burning
 * the grant, exactly as they did when this logic was inline.
 *
 * Ownership and un-revoked status of an update/activate target are
 * re-verified here, inside the caller's transaction, so a key revoked
 * between consent and redemption fails closed rather than being silently
 * re-scoped or re-approved.
 */
/**
 * Widens a `KeyGrantResult` into the shape both flows' result unions share,
 * attaching the grant context the helper deliberately doesn't know about.
 *
 * Both callers previously re-implemented this as an identical five-case
 * switch, so adding a sixth `KeyGrantResult` outcome meant the same edit in
 * two places — the drift `applyKeyGrant` was extracted to prevent, reappearing
 * one level up. Callers still own their own single-use bookkeeping, which is
 * the part that genuinely differs (consuming an authorization code vs. setting
 * `redeemedAt`).
 */
function withGrantContext(
  keyGrant: Exclude<KeyGrantResult, { outcome: 'not_a_key_grant' }>,
  userId: string,
  scopes: string[],
):
  | { outcome: 'ok_mcp_token'; userId: string; scopes: string[]; mcpToken: string }
  | { outcome: 'ok_mcp_update'; userId: string; scopes: string[]; tokenId: string }
  | { outcome: 'ok_mcp_activate'; userId: string; scopes: string[]; tokenId: string }
  | { outcome: 'update_target_gone' }
  | { outcome: 'activate_target_gone' } {
  switch (keyGrant.outcome) {
    case 'ok_mcp_token':
      return { outcome: 'ok_mcp_token', userId, scopes, mcpToken: keyGrant.mcpToken };
    case 'ok_mcp_update':
      return { outcome: 'ok_mcp_update', userId, scopes, tokenId: keyGrant.tokenId };
    case 'ok_mcp_activate':
      return { outcome: 'ok_mcp_activate', userId, scopes, tokenId: keyGrant.tokenId };
    case 'update_target_gone':
    case 'activate_target_gone':
      return { outcome: keyGrant.outcome };
  }
}

async function applyKeyGrant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { userId: string; scopes: string[] },
): Promise<KeyGrantResult> {
  const parsed = parseScopeList(input.scopes.join(' '));
  // Every branch below is gated on a successful parse; a scope array this
  // parser rejects is not a key grant as far as this helper is concerned, and
  // the caller's own fallthrough decides what to do with it.
  if (!parsed.ok) return { outcome: 'not_a_key_grant' };
  const scopes = parsed.scopes;

  // An `update_key:<tokenId>` grant re-scopes the consenting user's EXISTING
  // mcp token in place — nothing is minted and `tokenHash` is never read or
  // written, so there is no secret to return. The target token id was bound
  // into the consent (it rides inside `scope`, which the step-up grant's
  // action binding covers) and the grant row binds `userId`; nothing the
  // client presents at redemption can retarget either.
  if (isKeyUpdateGrant(scopes)) {
    const updated = await sessionRepository.updateMcpTokenDriveScopes(
      scopes.updateKeyId,
      input.userId,
      toSessionRepoDrives(scopes),
      tx,
    );
    if (updated === null) return { outcome: 'update_target_gone' };
    return { outcome: 'ok_mcp_update', tokenId: scopes.updateKeyId };
  }

  // An `activate_key:<tokenId>` grant is a pure approval ceremony: the human
  // confirmed in a browser that the requesting device may make this EXISTING
  // key its ambient default (`pagespace keys use`). Nothing is minted,
  // nothing is re-scoped, and no secret is read or returned — the verified
  // success signal IS the product.
  if (isKeyActivationGrant(scopes)) {
    const target = await sessionRepository.findActiveMcpTokenByIdAndUser(scopes.activateKeyId, input.userId);
    if (!target) return { outcome: 'activate_target_gone' };
    return { outcome: 'ok_mcp_activate', tokenId: scopes.activateKeyId };
  }

  // A pure drive:* grant OR an `all_drives` grant both mint a real
  // `mcp_tokens` row, not an OAuth refresh/access-token pair — the browser
  // consent screen is still the human-approval gate for either. `all_drives`
  // is the CLI/wizard equivalent of the web Settings > MCP "Clear selection
  // (allow all drives)" key: unrestricted access to every drive the user
  // owns, including ones created later, persisted `isScoped: false` with zero
  // drive rows instead of a drive-scoped set. Deliberately NOT the `account`
  // scope: `account` also grants full account control beyond drives (it
  // resolves to a full personal OAuth session at the auth layer), which this
  // feature must never silently produce.
  if (isAllDrivesGrant(scopes) || isPureDriveGrant(scopes)) {
    const allDrives = isAllDrivesGrant(scopes);
    const { token: mcpToken, hash: tokenHash, tokenPrefix } = generateToken('mcp');
    await sessionRepository.createMcpTokenWithDriveScopes(
      {
        userId: input.userId,
        tokenHash,
        tokenPrefix,
        // Fallback is unreachable in practice: a mint-shaped grant with no
        // name never gets this far — both entry points reject it before a
        // redeemable grant is ever persisted (POST /api/oauth/authorize's
        // validateAuthorizeRequest for the loopback flow; the
        // device_authorization endpoint's own mint-name requirement for the
        // device flow). NOT enforced by parseScopeList itself (that parser
        // stays flow-agnostic — see its name_without_mint_grant rule and the
        // doc comment on ScopeSet.newKeyName for why). Kept as defense in
        // depth only, never meant to actually fire.
        name: hasNewKeyName(scopes) ? scopes.newKeyName : 'pagespace CLI',
        isScoped: !allDrives,
        drives: allDrives ? [] : toSessionRepoDrives(scopes),
      },
      tx,
    );

    return { outcome: 'ok_mcp_token', mcpToken };
  }

  return { outcome: 'not_a_key_grant' };
}

async function revokeTokenFamily(
  tx: Pick<typeof db, 'update'>,
  familyId: string,
  now: Date,
  reason: string,
): Promise<void> {
  await tx
    .update(oauthRefreshTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));

  await tx
    .update(oauthAccessTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(oauthAccessTokens.familyId, familyId), isNull(oauthAccessTokens.revokedAt)));
}

/**
 * Atomically consume an authorization code and, on success, issue the
 * initial token pair for a brand-new refresh-token family (task 7).
 *
 * `FOR UPDATE` locks the code row for the duration of the transaction, so a
 * second concurrent exchange of the same code blocks until the first
 * commits, then observes `consumedAt` already set — decideCodeExchange
 * (task 4, pure, not reimplemented here) turns that into `already_consumed`,
 * which revokes every token the first exchange issued (ADR 0003 §2).
 */
export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<ExchangeAuthorizationCodeResult> {
  const codeHash = hashToken(input.code);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: oauthAuthorizationCodes.id,
        clientId: oauthAuthorizationCodes.clientId,
        userId: oauthAuthorizationCodes.userId,
        scopes: oauthAuthorizationCodes.scopes,
        redirectUri: oauthAuthorizationCodes.redirectUri,
        codeChallenge: oauthAuthorizationCodes.codeChallenge,
        expiresAt: oauthAuthorizationCodes.expiresAt,
        consumedAt: oauthAuthorizationCodes.consumedAt,
        issuedFamilyId: oauthAuthorizationCodes.issuedFamilyId,
      })
      .from(oauthAuthorizationCodes)
      .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), eq(oauthAuthorizationCodes.clientId, input.clientDbId)))
      .for('update');

    const row = rows[0];
    if (!row) {
      return { outcome: 'not_found' };
    }

    const decision = decideCodeExchange(
      {
        clientId: row.clientId,
        userId: row.userId,
        scopes: row.scopes,
        redirectUri: row.redirectUri,
        codeChallenge: row.codeChallenge,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      },
      { redirectUri: input.redirectUri, codeVerifier: input.codeVerifier },
      input.now,
    );

    if (decision.status === 'already_consumed') {
      if (row.issuedFamilyId) {
        await revokeTokenFamily(tx, row.issuedFamilyId, input.now, 'code_reuse');
      }
      return { outcome: 'rejected', decision };
    }

    if (decision.status !== 'ok') {
      return { outcome: 'rejected', decision };
    }

    const userRows = await tx
      .select({ tokenVersion: users.tokenVersion, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, row.userId));
    const tokenVersion = userRows[0]?.tokenVersion ?? 0;

    // Zero trust, mirrors mcp-token suspension handling: a suspended user's
    // authorization code is single-use dead (consumed below) but mints no
    // tokens at all — never hand out a family that would only be dead on
    // first use.
    if (userRows[0]?.suspendedAt) {
      await tx
        .update(oauthAuthorizationCodes)
        .set({ consumedAt: input.now })
        .where(eq(oauthAuthorizationCodes.id, row.id));
      return { outcome: 'user_suspended' };
    }

    // A pure drive:* grant (no `account`, no `manage_keys`) is content
    // access, not a login session — mint a real `mcp_tokens` row (the same
    // entity `keys list`/`keys revoke`/Settings > MCP already manage)
    // instead of an OAuth refresh/access-token pair. The browser consent
    // screen that already gated this authorization code (step-up ceremony,
    // `/api/oauth/authorize`) is the human-approval property this preserves;
    // only what gets PERSISTED on success changes. `manage_keys`/`account`
    // grants (`pagespace login`) are untouched — see `isPureDriveGrant`.
    //
    // Shared verbatim with the device flow (`pollDeviceToken`) — see
    // `applyKeyGrant`. Every non-`not_a_key_grant` outcome consumes the code,
    // the two `*_target_gone` failures included: a burned code on a target
    // that vanished between consent and exchange is the fail-closed result,
    // and the route collapses both to the constant-shape invalid_grant.
    // Deliberately no `issuedFamilyId` on any of them: replaying a consumed
    // code then hits `already_consumed` above with nothing to revoke, which
    // is correct — no credential family was ever issued for it.
    const keyGrant = await applyKeyGrant(tx, { userId: row.userId, scopes: row.scopes });
    if (keyGrant.outcome !== 'not_a_key_grant') {
      await tx
        .update(oauthAuthorizationCodes)
        .set({ consumedAt: input.now })
        .where(eq(oauthAuthorizationCodes.id, row.id));
      return withGrantContext(keyGrant, row.userId, row.scopes);
    }

    // NOTE: every mint/update/activate branch is gated on a successful
    // `parseScopeList` inside `applyKeyGrant`. If that parser ever rejects
    // the persisted `row.scopes` for any reason (including some future
    // unrelated bug), it reports `not_a_key_grant` and we
    // fall through to here and mint a plain OAuth access/refresh pair
    // carrying the raw (rejected) scope array as its granted scopes — a
    // pre-existing fail-open risk, unrelated to and out of scope for this
    // change. Flagged for a future hardening pass.
    //
    // F1 (ADR 0003, OIDC-standard): a refresh token is only minted when the
    // granted scope set includes offline_access — otherwise this is an
    // access-only grant.
    const offlineAccess = row.scopes.includes('offline_access');
    const tokens = issueInitialTokenPair(input.now, offlineAccess);

    await tx
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: input.now, issuedFamilyId: tokens.familyId })
      .where(eq(oauthAuthorizationCodes.id, row.id));

    if (tokens.refreshToken !== undefined) {
      await tx.insert(oauthRefreshTokens).values({
        tokenHash: tokens.refreshTokenHash,
        tokenPrefix: tokens.refreshTokenPrefix,
        familyId: tokens.familyId,
        clientId: input.clientDbId,
        userId: row.userId,
        scopes: row.scopes,
        tokenVersion,
        expiresAt: tokens.refreshExpiresAt,
        familyExpiresAt: tokens.familyExpiresAt,
      });
    }

    await tx.insert(oauthAccessTokens).values({
      tokenHash: tokens.accessTokenHash,
      tokenPrefix: tokens.accessTokenPrefix,
      familyId: tokens.familyId,
      clientId: input.clientDbId,
      userId: row.userId,
      scopes: row.scopes,
      tokenVersion,
      expiresAt: tokens.accessExpiresAt,
    });

    return { outcome: 'ok', userId: row.userId, scopes: row.scopes, tokens };
  });
}

export interface RevokeOAuthTokenInput {
  /** Raw token from the revocation request; hashed before any lookup. */
  token: string;
  /** Resolved `oauth_clients.id` for the request's client_id — a token issued
   * to a different client is indistinguishable from an unknown token: the
   * update's WHERE clause simply matches nothing (no oracle). */
  clientDbId: string;
  now: Date;
}

const OAUTH_REFRESH_TOKEN_PREFIX = 'ps_rt_';

/**
 * RFC 7009 revocation (task qyqgrjbvntpsdh578k0yiwgr). A refresh token
 * revokes its whole family (reusing `revokeTokenFamily`, the same helper the
 * reuse-detection paths above use); an access token revokes only itself. An
 * unknown token, a foreign token (different client), an already-revoked
 * token, or a token in neither opaque format is a silent no-op — the route
 * layer always returns 200 regardless, so nothing here needs to report which
 * case occurred.
 */
export async function revokeOAuthToken(input: RevokeOAuthTokenInput): Promise<void> {
  const tokenHash = hashToken(input.token);

  if (input.token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    const rows = await db
      .select({ familyId: oauthRefreshTokens.familyId })
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, input.clientDbId)));

    const row = rows[0];
    if (row) {
      await revokeTokenFamily(db, row.familyId, input.now, 'client_revoked');
    }
    return;
  }

  if (input.token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: input.now, revokedReason: 'client_revoked' })
      .where(
        and(
          eq(oauthAccessTokens.tokenHash, tokenHash),
          eq(oauthAccessTokens.clientId, input.clientDbId),
          isNull(oauthAccessTokens.revokedAt),
        ),
      );
    return;
  }

  // Neither opaque format — foreign/garbage token, no-op (no oracle upstream).
}

export interface RefreshTokenGrantInput {
  /** Raw refresh token from the token request; hashed before any lookup. */
  refreshToken: string;
  /** Resolved `oauth_clients.id` for the request's client_id — the lookup
   * below is scoped to this, so a token issued to a different client is
   * indistinguishable from an unknown token (no oracle). */
  clientDbId: string;
  /** Raw `scope` form param, or null when absent (keep the granted scope). */
  requestedScope: string | null;
  now: Date;
}

export type RefreshTokenGrantResult =
  | { outcome: 'invalid_grant' }
  | { outcome: 'invalid_scope' }
  | { outcome: 'ok'; userId: string; scopes: string[]; tokens: IssuedTokenPair };

/**
 * Atomically rotate a refresh token (task l8zlp3353f2cunjd33foq41l, ADR 0003
 * §3.3-3.4). `FOR UPDATE` locks the token row for the transaction's
 * duration — the model is identical to `exchangeAuthorizationCode`'s code
 * lock: a second concurrent refresh of the same token blocks until the first
 * commits, then observes the row already rotated. The grace-cache lookup
 * (ADR 0003 §3.4) is deferred infra — this shell always supplies
 * `graceCacheHit: false`, so `decideRefreshRotation` never returns
 * `grace-replay` here; a genuine concurrent race lands on `grace_cache_miss`
 * (family untouched, loser gets `invalid_grant`) rather than a false theft
 * accusation.
 */
export async function refreshTokenGrant(input: RefreshTokenGrantInput): Promise<RefreshTokenGrantResult> {
  const tokenHash = hashToken(input.refreshToken);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: oauthRefreshTokens.id,
        userId: oauthRefreshTokens.userId,
        scopes: oauthRefreshTokens.scopes,
        tokenVersion: oauthRefreshTokens.tokenVersion,
        expiresAt: oauthRefreshTokens.expiresAt,
        familyExpiresAt: oauthRefreshTokens.familyExpiresAt,
        familyId: oauthRefreshTokens.familyId,
        revokedAt: oauthRefreshTokens.revokedAt,
        revokedReason: oauthRefreshTokens.revokedReason,
      })
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, input.clientDbId)))
      .for('update');

    const row = rows[0];
    if (!row) {
      return { outcome: 'invalid_grant' };
    }

    // Fetched up front (not just for the suspension check below): the
    // decision itself needs the user's CURRENT tokenVersion to detect a
    // global "logout all devices" that happened since this token's snapshot.
    const userRows = await tx
      .select({ suspendedAt: users.suspendedAt, tokenVersion: users.tokenVersion })
      .from(users)
      .where(eq(users.id, row.userId));
    const currentTokenVersion = userRows[0]?.tokenVersion ?? 0;

    const decision = decideRefreshRotation(
      {
        expiresAt: row.expiresAt,
        familyExpiresAt: row.familyExpiresAt,
        revokedAt: row.revokedAt,
        revokedReason: row.revokedReason,
        tokenVersion: row.tokenVersion,
      },
      currentTokenVersion,
      input.now,
      false,
    );

    if (!decision.ok) {
      if (decision.revokeFamily) {
        await revokeTokenFamily(tx, row.familyId, input.now, 'reuse_detected');
      }
      return { outcome: 'invalid_grant' };
    }

    if (decision.action === 'grace-replay') {
      // Unreachable while graceCacheHit is hardcoded false above; see the
      // module-level doc comment.
      return { outcome: 'invalid_grant' };
    }

    // Zero trust, mirrors mcp-token suspension handling: a suspended user's
    // refresh token is not just denied THIS rotation — the whole family is
    // killed outright, the same way an MCP token is revoked on sight, rather
    // than left alive to keep minting access tokens that only die on first
    // use (constant-shape: same invalid_grant a reused/expired token gets).
    if (userRows[0]?.suspendedAt) {
      await revokeTokenFamily(tx, row.familyId, input.now, 'user_suspended');
      return { outcome: 'invalid_grant' };
    }

    let scopes = row.scopes;
    if (input.requestedScope !== null) {
      const requested = parseScopeList(input.requestedScope);
      const granted = parseScopeList(row.scopes.join(' '));
      if (!requested.ok || !granted.ok || !isScopeSubset(requested.scopes, granted.scopes)) {
        return { outcome: 'invalid_scope' };
      }
      scopes = formatScopeSet(requested.scopes).split(' ');
    }

    // F1 (ADR 0003, OIDC-standard): a client that narrows scope to drop
    // offline_access ends the refresh chain here — the rotated pair is
    // access-only and there is nothing left to replace the presented token.
    const offlineAccess = scopes.includes('offline_access');
    const newRefreshId = offlineAccess ? createId() : null;
    const tokens = issueRotatedTokenPair(input.now, row.familyId, row.familyExpiresAt, offlineAccess);

    // decideRefreshRotation's grace-window branch keys off revokedReason ===
    // 'rotated' (not replacedByTokenId) precisely so a terminal (access-only)
    // rotation — no next refresh row to point to — still lands a benign
    // in-window retry on grace_cache_miss rather than reuse_detected.
    // replacedByTokenId stays an honest null for a terminal rotation.
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: input.now, revokedReason: 'rotated', replacedByTokenId: newRefreshId })
      .where(eq(oauthRefreshTokens.id, row.id));

    if (tokens.refreshToken !== undefined && newRefreshId !== null) {
      await tx.insert(oauthRefreshTokens).values({
        id: newRefreshId,
        tokenHash: tokens.refreshTokenHash,
        tokenPrefix: tokens.refreshTokenPrefix,
        familyId: tokens.familyId,
        clientId: input.clientDbId,
        userId: row.userId,
        scopes,
        tokenVersion: row.tokenVersion,
        expiresAt: tokens.refreshExpiresAt,
        familyExpiresAt: tokens.familyExpiresAt,
      });
    }

    await tx.insert(oauthAccessTokens).values({
      tokenHash: tokens.accessTokenHash,
      tokenPrefix: tokens.accessTokenPrefix,
      familyId: tokens.familyId,
      clientId: input.clientDbId,
      userId: row.userId,
      scopes,
      tokenVersion: row.tokenVersion,
      expiresAt: tokens.accessExpiresAt,
    });

    return { outcome: 'ok', userId: row.userId, scopes, tokens };
  });
}

// ---------------------------------------------------------------------------
// Device authorization grant (RFC 8628; task mwexjazwha2uhw5bmvc9a7kw).
// ---------------------------------------------------------------------------

interface DeviceCodeRow {
  id: string;
  clientId: string;
  userId: string | null;
  scopes: string[];
  expiresAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  redeemedAt: Date | null;
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
}

/** Map a DB row onto task 4's `DeviceCodeRecord` discriminated union. */
function toDeviceCodeRecord(row: DeviceCodeRow): DeviceCodeRecord {
  const common = {
    clientId: row.clientId,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    lastPolledAt: row.lastPolledAt,
    pollIntervalSeconds: row.pollIntervalSeconds,
  };

  // Checked before denied/approved: redemption is the strongest terminal
  // state, and a redeemed code must never read back as freshly approved and
  // issue credentials a second time (RFC 8628 §3.5).
  if (row.redeemedAt !== null) {
    return { status: 'redeemed', ...common };
  }
  if (row.deniedAt !== null) {
    return { status: 'denied', ...common };
  }
  if (row.approvedAt !== null && row.userId !== null) {
    return { status: 'approved', approvedUserId: row.userId, ...common };
  }
  return { status: 'pending', ...common };
}

export interface CreateDeviceAuthorizationInput {
  clientDbId: string;
  scopes: string[];
  deviceCodeHash: string;
  deviceCodePrefix: string;
  userCodeHash: string;
  userCodePrefix: string;
  expiresAt: Date;
  pollIntervalSeconds: number;
}

export async function createDeviceAuthorization(input: CreateDeviceAuthorizationInput): Promise<void> {
  await db.insert(oauthDeviceCodes).values({
    deviceCodeHash: input.deviceCodeHash,
    deviceCodePrefix: input.deviceCodePrefix,
    userCodeHash: input.userCodeHash,
    userCodePrefix: input.userCodePrefix,
    clientId: input.clientDbId,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    pollIntervalSeconds: input.pollIntervalSeconds,
  });
}

export interface PollDeviceTokenInput {
  /** Raw device_code from the token request; hashed before any lookup. */
  deviceCode: string;
  /** Resolved `oauth_clients.id` — scopes the lookup so a device_code minted
   * for a different client is indistinguishable from an unknown one. */
  clientDbId: string;
  now: Date;
}

export type PollDeviceTokenResult =
  | { outcome: 'not_found' }
  | { outcome: 'authorization_pending' }
  | { outcome: 'slow_down' }
  | { outcome: 'expired_token' }
  | { outcome: 'access_denied' }
  /** Already exchanged (RFC 8628 §3.5) — the route collapses this to invalid_grant. */
  | { outcome: 'already_redeemed' }
  | { outcome: 'user_suspended' }
  /** An `all_drives` grant reached redemption despite the device door refusing it — see the check in `pollDeviceToken`. */
  | { outcome: 'all_drives_unsupported' }
  | { outcome: 'ok'; userId: string; scopes: string[]; tokens: IssuedTokenPair }
  /** Key-shaped grants, shared verbatim with the authorization-code exchange via `applyKeyGrant`. */
  | { outcome: 'ok_mcp_token'; userId: string; scopes: string[]; mcpToken: string }
  | { outcome: 'ok_mcp_update'; userId: string; scopes: string[]; tokenId: string }
  | { outcome: 'ok_mcp_activate'; userId: string; scopes: string[]; tokenId: string }
  | { outcome: 'update_target_gone' }
  | { outcome: 'activate_target_gone' };

/**
 * Atomically poll a device code (RFC 8628 §3.4-3.5). `FOR UPDATE` locks the
 * row for the transaction's duration, mirroring `exchangeAuthorizationCode`'s
 * lock model. `decideDevicePoll` (task 4, not reimplemented) makes the
 * decision; this function's only added responsibility is persisting
 * `lastPolledAt` — real persistence is what makes the `slow_down` throttle
 * enforceable across separate HTTP requests rather than just describable in
 * memory — and, on `ok`, minting the initial token pair via the exact same
 * path task 7 uses.
 *
 * The anchor only advances on an *allowed* poll (`authorization_pending`),
 * never on a throttled one: a client hammering the endpoint faster than
 * `pollIntervalSeconds` must wait out the interval from its last ALLOWED
 * poll, not get a fresh countdown on every rejected attempt — otherwise
 * tight retries could push the anchor forward indefinitely and the interval
 * would never actually elapse from the client's point of view.
 */
export async function pollDeviceToken(input: PollDeviceTokenInput): Promise<PollDeviceTokenResult> {
  const deviceCodeHash = hashToken(input.deviceCode);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: oauthDeviceCodes.id,
        clientId: oauthDeviceCodes.clientId,
        userId: oauthDeviceCodes.userId,
        scopes: oauthDeviceCodes.scopes,
        expiresAt: oauthDeviceCodes.expiresAt,
        approvedAt: oauthDeviceCodes.approvedAt,
        deniedAt: oauthDeviceCodes.deniedAt,
        redeemedAt: oauthDeviceCodes.redeemedAt,
        lastPolledAt: oauthDeviceCodes.lastPolledAt,
        pollIntervalSeconds: oauthDeviceCodes.pollIntervalSeconds,
      })
      .from(oauthDeviceCodes)
      .where(and(eq(oauthDeviceCodes.deviceCodeHash, deviceCodeHash), eq(oauthDeviceCodes.clientId, input.clientDbId)))
      .for('update');

    const row = rows[0];
    if (!row) {
      return { outcome: 'not_found' };
    }

    const record = toDeviceCodeRecord(row);
    const decision = decideDevicePoll(record, input.now);

    if (decision.status === 'authorization_pending') {
      await tx.update(oauthDeviceCodes).set({ lastPolledAt: input.now }).where(eq(oauthDeviceCodes.id, row.id));
    }

    if (decision.status !== 'ok') {
      return { outcome: decision.status };
    }

    const userRows = await tx
      .select({ tokenVersion: users.tokenVersion, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, decision.grant.userId));
    const tokenVersion = userRows[0]?.tokenVersion ?? 0;

    // Zero trust, mirrors mcp-token suspension handling: an approved device
    // code whose user is suspended mints no tokens at all.
    if (userRows[0]?.suspendedAt) {
      return { outcome: 'user_suspended' };
    }

    // Defense in depth. `POST /api/oauth/device_authorization` refuses to mint
    // a device code for an `all_drives` grant in the first place, for reasons
    // documented there (a device-minted all_drives token would land in a shape
    // the two authorization helper families read oppositely). This second
    // check means even a device-code row that somehow carries the grant — a
    // row predating that guard, or one written by a future code path — can
    // never be redeemed into such a token. Fails closed; the route reports it
    // as invalid_grant like any other unredeemable code.
    const parsedGrant = parseScopeList(decision.grant.scopes.join(' '));
    if (parsedGrant.ok && isAllDrivesGrant(parsedGrant.scopes)) {
      await tx.update(oauthDeviceCodes).set({ redeemedAt: input.now }).where(eq(oauthDeviceCodes.id, row.id));
      return { outcome: 'all_drives_unsupported' };
    }

    // Key-shaped grants (`keys create/edit/use --device`) apply through the
    // same `applyKeyGrant` the loopback authorization-code exchange uses, and
    // produce no OAuth token pair at all. Redemption is recorded for every
    // outcome including the two `*_target_gone` failures — a target that
    // vanished between consent and redemption burns the code rather than
    // leaving it live for a retry.
    const keyGrant = await applyKeyGrant(tx, { userId: decision.grant.userId, scopes: decision.grant.scopes });
    if (keyGrant.outcome !== 'not_a_key_grant') {
      await tx.update(oauthDeviceCodes).set({ redeemedAt: input.now }).where(eq(oauthDeviceCodes.id, row.id));
      return withGrantContext(keyGrant, decision.grant.userId, decision.grant.scopes);
    }

    // RFC 8628 §3.5: the device_code is invalidated on redemption, in the same
    // transaction that issues the credentials, so a concurrent second poll
    // blocks on the FOR UPDATE lock above and then reads `redeemed`.
    await tx.update(oauthDeviceCodes).set({ redeemedAt: input.now }).where(eq(oauthDeviceCodes.id, row.id));

    // F1 (ADR 0003, OIDC-standard): access-only unless offline_access was granted.
    const offlineAccess = decision.grant.scopes.includes('offline_access');
    const tokens = issueInitialTokenPair(input.now, offlineAccess);

    if (tokens.refreshToken !== undefined) {
      await tx.insert(oauthRefreshTokens).values({
        tokenHash: tokens.refreshTokenHash,
        tokenPrefix: tokens.refreshTokenPrefix,
        familyId: tokens.familyId,
        clientId: input.clientDbId,
        userId: decision.grant.userId,
        scopes: decision.grant.scopes,
        tokenVersion,
        expiresAt: tokens.refreshExpiresAt,
        familyExpiresAt: tokens.familyExpiresAt,
      });
    }

    await tx.insert(oauthAccessTokens).values({
      tokenHash: tokens.accessTokenHash,
      tokenPrefix: tokens.accessTokenPrefix,
      familyId: tokens.familyId,
      clientId: input.clientDbId,
      userId: decision.grant.userId,
      scopes: decision.grant.scopes,
      tokenVersion,
      expiresAt: tokens.accessExpiresAt,
    });

    return { outcome: 'ok', userId: decision.grant.userId, scopes: decision.grant.scopes, tokens };
  });
}

// ---------------------------------------------------------------------------
// Connected-apps listing + revoke-by-id (Phase 8 task k58h61obmc91sn1ndngrsev5).
// ---------------------------------------------------------------------------

export interface ActiveOAuthGrantRow {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: Date;
}

/** Active (unrevoked) grants for the settings > connected-apps listing page. */
export async function listActiveOAuthGrantsForUser(userId: string): Promise<ActiveOAuthGrantRow[]> {
  return db
    .select({
      id: oauthRefreshTokens.id,
      clientName: oauthClients.name,
      scopes: oauthRefreshTokens.scopes,
      createdAt: oauthRefreshTokens.createdAt,
    })
    .from(oauthRefreshTokens)
    .innerJoin(oauthClients, eq(oauthRefreshTokens.clientId, oauthClients.id))
    .where(and(eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt)));
}

export interface OAuthGrantRow {
  id: string;
  userId: string;
  familyId: string;
}

/**
 * Look up a grant by its row id alone — ownership is NOT checked here (the
 * route layer runs `isGrantOwnedByUser` against this result); already-revoked
 * rows are excluded so a double-revoke attempt gets the same `null` an
 * unknown id gets, rather than silently succeeding a second time.
 */
export async function findOAuthGrantById(grantId: string): Promise<OAuthGrantRow | null> {
  const rows = await db
    .select({ id: oauthRefreshTokens.id, userId: oauthRefreshTokens.userId, familyId: oauthRefreshTokens.familyId })
    .from(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.id, grantId), isNull(oauthRefreshTokens.revokedAt)));

  return rows[0] ?? null;
}

/** Reuses `revokeTokenFamily` — the exact same helper RFC 7009 revocation uses above. */
export async function revokeOAuthGrantFamily(familyId: string, now: Date): Promise<void> {
  await revokeTokenFamily(db, familyId, now, 'user_revoked');
}

export interface VerifyDeviceUserCodeInput {
  /** Already-normalized user code (uppercased, hyphen-free); hashed here. */
  userCode: string;
  now: Date;
}

export type VerifyDeviceUserCodeResult =
  | { outcome: 'not_found' }
  | { outcome: 'ok'; clientId: string; scopes: string[] };

/**
 * Read-only lookup for the /activate screen: is this user code currently
 * pending and unexpired? Unknown, expired, and already-settled (approved or
 * denied) codes all collapse to the same `not_found` outcome — a code that
 * can no longer be acted on is not this endpoint's business to explain.
 * Joins to `oauth_clients` to recover the static registry's string
 * `client_id` (the device-code row only carries the DB id).
 */
export async function verifyDeviceUserCode(input: VerifyDeviceUserCodeInput): Promise<VerifyDeviceUserCodeResult> {
  const userCodeHash = hashToken(input.userCode);

  const rows = await db
    .select({
      scopes: oauthDeviceCodes.scopes,
      expiresAt: oauthDeviceCodes.expiresAt,
      approvedAt: oauthDeviceCodes.approvedAt,
      deniedAt: oauthDeviceCodes.deniedAt,
      clientStringId: oauthClients.clientId,
    })
    .from(oauthDeviceCodes)
    .innerJoin(oauthClients, eq(oauthDeviceCodes.clientId, oauthClients.id))
    .where(eq(oauthDeviceCodes.userCodeHash, userCodeHash));

  const row = rows[0];
  if (!row) {
    return { outcome: 'not_found' };
  }

  const isSettled = row.approvedAt !== null || row.deniedAt !== null;
  const isExpired = input.now.getTime() >= row.expiresAt.getTime();
  if (isSettled || isExpired) {
    return { outcome: 'not_found' };
  }

  return { outcome: 'ok', clientId: row.clientStringId, scopes: row.scopes };
}

export interface RecordDeviceApprovalInput {
  /** Already-normalized user code; hashed here. */
  userCode: string;
  action: DeviceApprovalAction;
  userId: string;
  now: Date;
}

export type RecordDeviceApprovalResult =
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; decision: Extract<DeviceApprovalDecision, { status: 'already_settled' } | { status: 'expired' }> }
  | { outcome: 'approved' }
  | { outcome: 'denied' };

/**
 * Atomically record the user's approve/deny decision at /activate.
 * `decideDeviceApproval` (task 4, not reimplemented) makes the decision under
 * a `FOR UPDATE` lock, so a double-submit of the same code (double-click,
 * replayed request) settles exactly once.
 */
export async function recordDeviceApproval(input: RecordDeviceApprovalInput): Promise<RecordDeviceApprovalResult> {
  const userCodeHash = hashToken(input.userCode);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: oauthDeviceCodes.id,
        clientId: oauthDeviceCodes.clientId,
        userId: oauthDeviceCodes.userId,
        scopes: oauthDeviceCodes.scopes,
        expiresAt: oauthDeviceCodes.expiresAt,
        approvedAt: oauthDeviceCodes.approvedAt,
        deniedAt: oauthDeviceCodes.deniedAt,
        redeemedAt: oauthDeviceCodes.redeemedAt,
        lastPolledAt: oauthDeviceCodes.lastPolledAt,
        pollIntervalSeconds: oauthDeviceCodes.pollIntervalSeconds,
      })
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.userCodeHash, userCodeHash))
      .for('update');

    const row = rows[0];
    if (!row) {
      return { outcome: 'not_found' };
    }

    const record = toDeviceCodeRecord(row);
    const decision = decideDeviceApproval(record, input.action, input.userId, input.now);

    if (decision.status === 'approved') {
      await tx
        .update(oauthDeviceCodes)
        .set({ approvedAt: input.now, userId: input.userId })
        .where(eq(oauthDeviceCodes.id, row.id));
      return { outcome: 'approved' };
    }

    if (decision.status === 'denied') {
      await tx.update(oauthDeviceCodes).set({ deniedAt: input.now }).where(eq(oauthDeviceCodes.id, row.id));
      return { outcome: 'denied' };
    }

    return { outcome: 'invalid', decision };
  });
}
