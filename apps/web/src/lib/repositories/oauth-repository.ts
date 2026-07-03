/**
 * Repository for the OAuth 2.1 provider's persistence (Phase 1 task 6).
 * Isolates DB access from the /api/oauth/authorize route handler.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { oauthClients, oauthAuthorizationCodes } from '@pagespace/db/schema/oauth';
import type { RegisteredClient } from '@pagespace/lib/auth/oauth/clients';

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
