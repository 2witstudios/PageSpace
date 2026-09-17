/**
 * GET /api/ai/chat (provider settings) answers a page's own provider/model only
 * for a page the principal may view — against a real Postgres, through the real
 * auth door, for a drive-scoped mcp_ key and an OAuth grant alike (Phase 2b
 * widened this route to OAuth). Requires DATABASE_URL → a migrated Postgres.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

import { GET } from '../route';

async function mcpKey(userId: string, driveId: string): Promise<string> {
  const mcp = generateToken('mcp');
  const [key] = await db.insert(mcpTokens).values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'settings key', isScoped: true }).returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: 'MEMBER' });
  return mcp.token;
}

async function oauthGrant(userId: string, driveId: string): Promise<string> {
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'Settings App', clientType: 'public', redirectUris: ['https://settings.example/callback'],
    allowedGrantTypes: ['authorization_code'], allowedScopes: ['drive:member'], ownerUserId: userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId: createId(), clientId: client.id, userId,
    scopes: [`drive:${driveId}:member`], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

beforeAll(async () => {
  await ensureTestDb();
});

describe('GET /api/ai/chat — page settings only for a page in the credential\'s reach', () => {
  it.each(['mcp_ key', 'OAuth grant'] as const)('a %s scoped to drive X reads X\'s agent settings but not drive Y\'s', async (kind) => {
    const user = await factories.createUser({ currentAiProvider: 'zai', currentAiModel: 'glm-user-default' });
    const x = await factories.createDrive(user.id);
    const y = await factories.createDrive(user.id);
    const inX = await factories.createPage(x.id, { type: 'AI_CHAT', title: 'X agent', content: '', aiProvider: 'openrouter', aiModel: 'model-in-x' });
    const inY = await factories.createPage(y.id, { type: 'AI_CHAT', title: 'Y agent', content: '', aiProvider: 'openrouter', aiModel: 'model-in-y' });
    const token = kind === 'mcp_ key' ? await mcpKey(user.id, x.id) : await oauthGrant(user.id, x.id);

    const read = async (pageId: string) => {
      const res = await GET(new Request(`http://localhost/api/ai/chat?pageId=${pageId}`, { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status).toBe(200);
      return (await res.json()) as { currentModel: string };
    };

    expect((await read(inX.id)).currentModel).toBe('model-in-x');
    expect((await read(inY.id)).currentModel).toBe('glm-user-default');
  }, 30_000);
});
