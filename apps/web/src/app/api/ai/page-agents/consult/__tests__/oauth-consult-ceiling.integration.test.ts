/**
 * US5 acceptance (Sign in with PageSpace, Phase 2b): `POST /api/ai/page-agents/consult`
 * with a THIRD-PARTY OAuth drive grant succeeds end to end on a real Postgres,
 * and the tool calls the consulted agent makes are capped at the grant's role.
 *
 * Real: the route, the auth door (a `ps_at_` token row), the agent page, the
 * tool registry and every permission resolver. Scripted: the language model
 * (it asks for the same tool calls on every run) and the credit gate/usage
 * sink. The user OWNS both drives, so every refusal below is the credential's
 * ceiling, never the user's own ACL.
 *
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { MockLanguageModelV3 } from 'ai/test';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

const script = vi.hoisted(() => ({ toolCalls: [] as Array<{ toolName: string; input: Record<string, unknown> }>, seenTools: [] as string[][] }));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  isProviderError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r,
  createAIProvider: vi.fn(async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        call += 1;
        script.seenTools.push((options.tools ?? []).map((t) => t.name));
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        if (call === 1) {
          return {
            content: script.toolCalls.map((tc, i) => ({ type: 'tool-call' as const, toolCallId: `call-${i}`, toolName: tc.toolName, input: JSON.stringify(tc.input) })),
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
vi.mock('@/lib/ai/core/model-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/core/model-capabilities')>()),
  supportsTemperature: vi.fn(async () => false),
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: vi.fn(async () => ({ allowed: true, holdId: undefined })) }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/ai-monitoring')>()),
  AIMonitoring: { trackUsage: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastPageEvent: vi.fn(async () => undefined),
  broadcastDriveEvent: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));

// Object storage for page snapshots — infrastructure orthogonal to authorization.
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'version', contentRef: 'snapshot', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));

import { POST } from '../route';

async function grant(userId: string, scope: string): Promise<string> {
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'SwipeSend-like App', clientType: 'public', redirectUris: ['https://app.example/callback'],
    allowedGrantTypes: ['authorization_code', 'refresh_token'], allowedScopes: ['drive:admin', 'drive:member'], ownerUserId: userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId: createId(), clientId: client.id, userId,
    scopes: [scope], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

const title = async (pageId: string) => (await db.select({ title: pages.title }).from(pages).where(eq(pages.id, pageId)))[0]?.title;

beforeAll(async () => {
  await ensureTestDb();
});

describe('POST /api/ai/page-agents/consult with a third-party OAuth drive grant (US5)', () => {
  const run = async (role: 'admin' | 'member') => {
    const user = await factories.createUser();
    const x = await factories.createDrive(user.id);
    const y = await factories.createDrive(user.id);
    const agent = await factories.createPage(x.id, { type: 'AI_CHAT', title: 'Consulted agent', content: '', enabledTools: ['rename_page', 'create_drive'] });
    const docX = await factories.createPage(x.id, { title: 'Doc in X', content: 'x' });
    const docY = await factories.createPage(y.id, { title: 'Doc in Y', content: 'y' });
    const token = await grant(user.id, `drive:${x.id}:${role}`);

    script.seenTools.length = 0;
    script.toolCalls = [
      { toolName: 'rename_page', input: { currentTitle: 'Doc in X', pageId: docX.id, title: 'Renamed X' } },
      { toolName: 'rename_page', input: { currentTitle: 'Doc in Y', pageId: docY.id, title: 'Renamed Y' } },
    ];
    const res = await POST(new Request('http://localhost/api/ai/page-agents/consult', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, question: 'rename both docs' }),
    }));
    return { res, docX: docX.id, docY: docY.id };
  };

  it('drive:X:admin — succeeds, edits in X, is refused in Y (the user\'s own drive), and is never offered account-level tools', async () => {
    const { res, docX, docY } = await run('admin');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await title(docX)).toBe('Renamed X');
    expect(await title(docY)).toBe('Doc in Y');
    expect(script.seenTools[0]).toContain('rename_page');
    expect(script.seenTools[0]).not.toContain('create_drive');
  }, 60_000);

  it('drive:X:member — succeeds, and its tool calls are capped at MEMBER even though the user owns X', async () => {
    const { res, docX, docY } = await run('member');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await title(docX)).toBe('Doc in X');
    expect(await title(docY)).toBe('Doc in Y');
  }, 60_000);
});
