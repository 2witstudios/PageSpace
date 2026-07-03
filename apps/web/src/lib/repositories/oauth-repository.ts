/**
 * Repository for the OAuth 2.1 provider's persistence (Phase 1 tasks 6-7).
 * Isolates DB access from the /api/oauth/authorize and /api/oauth/token
 * route handlers.
 */

import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { oauthClients, oauthAuthorizationCodes, oauthRefreshTokens, oauthAccessTokens } from '@pagespace/db/schema/oauth';
import { users } from '@pagespace/db/schema/auth';
import type { RegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { decideCodeExchange, type CodeExchangeDecision } from '@pagespace/lib/auth/oauth/code-lifecycle';
import { issueInitialTokenPair, type IssuedTokenPair } from '@pagespace/lib/auth/oauth/issue-tokens';

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
  | { outcome: 'ok'; userId: string; scopes: string[]; tokens: IssuedTokenPair };

async function revokeTokenFamily(
  tx: Pick<typeof db, 'update'>,
  familyId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(oauthRefreshTokens)
    .set({ revokedAt: now, revokedReason: 'code_reuse' })
    .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));

  await tx
    .update(oauthAccessTokens)
    .set({ revokedAt: now, revokedReason: 'code_reuse' })
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
        await revokeTokenFamily(tx, row.issuedFamilyId, input.now);
      }
      return { outcome: 'rejected', decision };
    }

    if (decision.status !== 'ok') {
      return { outcome: 'rejected', decision };
    }

    const userRows = await tx.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, row.userId));
    const tokenVersion = userRows[0]?.tokenVersion ?? 0;

    const tokens = issueInitialTokenPair(input.now);

    await tx
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: input.now, issuedFamilyId: tokens.familyId })
      .where(eq(oauthAuthorizationCodes.id, row.id));

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
