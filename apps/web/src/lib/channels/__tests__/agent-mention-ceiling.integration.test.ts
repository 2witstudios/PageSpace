/**
 * A channel @-mention runs the mentioned agent under the REQUESTER's credential
 * ceiling (Sign in with PageSpace, Phase 2b — deferred and mention-driven runs).
 *
 * Before: `triggerMentionedAgentResponses` built its tool contexts from the bare
 * user id, so a drive-scoped MEMBER credential (an `mcp_` key or an OAuth grant)
 * posting "@agent rename that doc" had the agent act with the owning user's full
 * reach. Here the same mention, the same scripted model and the same real tools
 * run for a MEMBER key, a MEMBER grant and the owner's session: only the session
 * may rename. The user OWNS the drive, so a refusal can only be the ceiling.
 *
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { MockLanguageModelV3 } from 'ai/test';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveAgentMembers, mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

const script = vi.hoisted(() => ({ renameTarget: '' }));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  isProviderError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r,
  createAIProvider: vi.fn(async () => {
    let call = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [{ type: 'tool-call' as const, toolCallId: 'call-rename', toolName: 'rename_page', input: JSON.stringify({ currentTitle: 'Doc', pageId: script.renameTarget, title: 'Renamed by mention' }) }],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
            usage,
            warnings: [],
          };
        }
        return { content: [{ type: 'text' as const, text: 'done' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
      },
    });
    return { model, provider: 'openrouter', modelName: 'mock-model' };
  }),
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/ai-monitoring')>()),
  AIMonitoring: { trackUsage: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/ai/core/compaction/compaction-service', () => ({ runCompaction: vi.fn(async () => undefined) }));
vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastPageEvent: vi.fn(async () => undefined),
  broadcastDriveEvent: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'version', contentRef: 'snapshot', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { toolCredentialScope } from '@/lib/ai/core/tool-credential-scope';
// The tool registry first: the tool modules import each other cyclically through it.
import '@/lib/ai/core/ai-tools';
import { triggerMentionedAgentResponses } from '../agent-mention-responder';

async function mcpKey(userId: string, driveId: string): Promise<string> {
  const mcp = generateToken('mcp');
  const [key] = await db.insert(mcpTokens).values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'mention key', isScoped: true }).returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: 'MEMBER' });
  return mcp.token;
}

async function oauthGrant(userId: string, driveId: string): Promise<string> {
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'Mention App', clientType: 'public', redirectUris: ['https://mention.example/callback'],
    allowedGrantTypes: ['authorization_code'], allowedScopes: ['drive:member'], ownerUserId: userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId: createId(), clientId: client.id, userId,
    scopes: [`drive:${driveId}:member`], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

const titleOf = async (pageId: string) => (await db.select({ title: pages.title }).from(pages).where(eq(pages.id, pageId)))[0]?.title;

beforeAll(async () => {
  await ensureTestDb();
});

describe('a channel @-mention runs the agent under the requester\'s credential ceiling', () => {
  it.each(['mcp_ key', 'OAuth grant', 'session'] as const)('MEMBER %s', async (kind) => {
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL', title: 'General', content: '' });
    const agent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Helper', content: '', enabledTools: ['send_channel_message', 'rename_page'] });
    const doc = await factories.createPage(drive.id, { title: 'Doc', content: 'body' });
    // The agent is a member of its drive, so it may post its reply in the channel.
    await db.insert(driveAgentMembers).values({ driveId: drive.id, agentPageId: agent.id, role: 'MEMBER', addedBy: user.id });
    script.renameTarget = doc.id;

    let credentialScope = {};
    if (kind !== 'session') {
      const token = kind === 'mcp_ key' ? await mcpKey(user.id, drive.id) : await oauthGrant(user.id, drive.id);
      const auth = await authenticateRequestWithOptions(
        new Request('http://localhost/api/channels/x/messages', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
        { allow: ['session', 'mcp', 'oauth'], requireCSRF: true },
      );
      if (isAuthError(auth)) throw new Error('credential did not authenticate');
      credentialScope = toolCredentialScope(auth);
    }

    await triggerMentionedAgentResponses({
      userId: user.id,
      channelId: channel.id,
      channelTitle: 'General',
      channelType: 'CHANNEL',
      sourceMessageId: createId(),
      content: `@[Helper](${agent.id}:page) please rename the doc`,
      driveId: drive.id,
      driveName: drive.name,
      driveSlug: drive.slug,
      credentialScope,
    });

    expect(await titleOf(doc.id)).toBe(kind === 'session' ? 'Renamed by mention' : 'Doc');
  }, 60_000);
});
