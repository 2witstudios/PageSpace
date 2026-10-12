// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { oauthClients, oauthAccessTokens, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { deriveCodeChallenge } from '@pagespace/lib/auth/oauth/pkce';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import {
  createAuthorizationCode, exchangeAuthorizationCode, refreshTokenGrant,
  createDeviceAuthorization, recordDeviceApproval, pollDeviceToken,
} from '../oauth-repository';

const userIds: string[] = [];
const clientIds: string[] = [];
const redirectUri = 'http://127.0.0.1:12345/callback';
const codeVerifier = 'a'.repeat(64);

async function fixture() {
  const user = await factories.createUser();
  userIds.push(user.id);
  const [client] = await db.insert(oauthClients).values({
    clientId: createId(), name: 'Evidence test', clientType: 'public', redirectUris: [redirectUri],
  }).returning();
  clientIds.push(client.id);
  const authentication = { authenticatedAtMs: Date.now() - 3600000, assurance: 'user_verified_passkey' as const };
  const stored = { authenticatedAt: new Date(authentication.authenticatedAtMs), authenticationAssurance: authentication.assurance };
  return { userId: user.id, clientDbId: client.id, authentication, stored };
}

afterEach(async () => {
  if (clientIds.length) await db.delete(oauthClients).where(inArray(oauthClients.id, clientIds.splice(0)));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

describe('SEC-2 SEC-3 (partial) credential evidence in PostgreSQL', () => {
  it('keeps the consent ceremony through code exchange and repeated OAuth refresh', async () => {
    const f = await fixture();
    const code = createId();
    await createAuthorizationCode({ ...f, redirectUri, codeChallenge: deriveCodeChallenge(codeVerifier),
      codeChallengeMethod: 'S256', scopes: ['account', 'offline_access'], codeHash: hashToken(code),
      codePrefix: code.slice(0, 12), expiresAt: new Date(Date.now() + 60000),
    });
    const exchanged = await exchangeAuthorizationCode({ code, codeVerifier, redirectUri, clientDbId: f.clientDbId, now: new Date() });
    expect(exchanged.outcome).toBe('ok');
    if (exchanged.outcome !== 'ok' || !exchanged.tokens.refreshToken) throw new Error('Expected refresh family');
    let refreshToken = exchanged.tokens.refreshToken;
    for (let i = 0; i < 2; i += 1) {
      const rotated = await refreshTokenGrant({ refreshToken, clientDbId: f.clientDbId, requestedScope: null, now: new Date() });
      expect(rotated.outcome).toBe('ok');
      if (rotated.outcome !== 'ok' || !rotated.tokens.refreshToken) throw new Error('Expected rotated family');
      refreshToken = rotated.tokens.refreshToken;
    }
    const access = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.userId, f.userId));
    const refresh = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, f.userId));
    expect(access).toHaveLength(3);
    expect(refresh).toHaveLength(3);
    for (const row of [...access, ...refresh]) expect(row).toMatchObject(f.stored);
  });

  it('copies an approved device ceremony into the issued OAuth family', async () => {
    const f = await fixture();
    const deviceCode = createId();
    const userCode = 'ABCDEFGH';
    await createDeviceAuthorization({ clientDbId: f.clientDbId, scopes: ['account', 'offline_access'],
      deviceCodeHash: hashToken(deviceCode), deviceCodePrefix: deviceCode.slice(0, 12),
      userCodeHash: hashToken(userCode), userCodePrefix: 'ABCD', expiresAt: new Date(Date.now() + 60000), pollIntervalSeconds: 5,
    });
    expect(await recordDeviceApproval({ ...f, userCode, action: 'approve', now: new Date() })).toEqual({ outcome: 'approved' });
    expect((await pollDeviceToken({ deviceCode, clientDbId: f.clientDbId, now: new Date() })).outcome).toBe('ok');
    const [access] = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.userId, f.userId));
    const [refresh] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, f.userId));
    expect(access).toMatchObject(f.stored);
    expect(refresh).toMatchObject(f.stored);
  });

  it('copies the consenting ceremony to an MCP key instead of creating fresh evidence at exchange', async () => {
    const f = await fixture();
    const code = createId();
    await createAuthorizationCode({ ...f, redirectUri, codeChallenge: deriveCodeChallenge(codeVerifier),
      codeChallengeMethod: 'S256', scopes: ['all_drives', 'name:Evidence'], codeHash: hashToken(code),
      codePrefix: code.slice(0, 12), expiresAt: new Date(Date.now() + 60000),
    });
    const result = await exchangeAuthorizationCode({ code, codeVerifier, redirectUri, clientDbId: f.clientDbId, now: new Date() });
    expect(result.outcome).toBe('ok_mcp_token');
    const [key] = await db.select().from(mcpTokens).where(eq(mcpTokens.userId, f.userId));
    expect(key).toMatchObject(f.stored);
  });
});
