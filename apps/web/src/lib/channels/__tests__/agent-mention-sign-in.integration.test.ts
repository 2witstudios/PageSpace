// @vitest-environment node
/**
 * D-OW-62 (review #2866 part A, P1-1): a channel @mention runs as the SENDER'S CREDENTIAL, never as an automation of
 * them. End to end against PostgreSQL: a real session token posts the mention through the real channel messages POST
 * route; the responder resolves the agent, gates the mentioner, runs the agent's real `read_page` tool and posts the
 * reply. The agent is a member of an org drive whose org requires a passkey sign-in, and the "model" asks it to read a
 * page there.
 *
 * Faked, and only these: the language model (a mock that issues one `read_page` call and then echoes the tool result
 * it was handed), the reply's credit hold and usage billing (wallet machinery, not access), and realtime broadcasts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { MockLanguageModelV3 } from 'ai/test';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { channelMessages } from '@pagespace/db/schema/chat';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

const modelCalls = vi.hoisted(() => ({ prompts: [] as string[], orgPageId: '' }));

/** A model that asks for the org page once, then repeats whatever the tool handed back. */
function readOrgPageModel() {
  let step = 0;
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      step += 1;
      const prompt = JSON.stringify(options.prompt);
      modelCalls.prompts.push(prompt);
      if (step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: `call-${createId()}`, toolName: 'read_page', input: JSON.stringify({ title: 'Roadmap', pageId: modelCalls.orgPageId }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: `I read: ${prompt.slice(-400)}` }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    },
  });
}

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/core/provider-factory')>()),
  createAIProvider: vi.fn(async () => ({ model: readOrgPageModel(), provider: 'mock', modelName: 'mock' })),
}));
vi.mock('@/lib/channels/mention-credit-gate', () => ({
  acquireMentionCreditHold: vi.fn(async () => ({ allowed: true, creditSpend: { spend: { kind: 'personal' } }, release: () => {} })),
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: vi.fn(async () => {}) } }));
vi.mock('@/lib/websocket', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) stubbed[name] = typeof value === 'function' && name.startsWith('broadcast') ? vi.fn(async () => {}) : value;
  return stubbed;
});

// The tool registry and the workflow executor import each other; load the registry first, as the app's agent routes do.
import '@/lib/ai/core/ai-tools';
import { POST as postChannelMessage } from '@/app/api/channels/[pageId]/messages/route';

const created = { users: [] as string[], orgs: [] as string[] };

async function acme() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId: person.id, policies: { requireStrongSignIn: true } }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Roadmap', content: 'ACME-ORG-SECRET' });
  const personal = await factories.createDrive(person.id);
  const channel = await factories.createPage(personal.id, { title: 'General', type: 'CHANNEL', content: '' });
  const agent = await factories.createPage(personal.id, { title: 'Helper', type: 'AI_CHAT', content: '', enabledTools: ['read_page', 'send_channel_message'] });
  // A member of its home drive (so it may post in the channel) and of the org drive (so it may read there).
  await db.insert(driveAgentMembers).values([
    { driveId: personal.id, agentPageId: agent.id, role: 'MEMBER', addedBy: person.id },
    { driveId: orgDrive.id, agentPageId: agent.id, role: 'MEMBER', addedBy: person.id },
  ]);
  modelCalls.orgPageId = orgPage.id;
  modelCalls.prompts = [];
  return { person, orgPage, channel, agent };
}

const session = (userId: string, authentication: VerifiedAuthentication) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 3_600_000, authentication });

async function mention(channelId: string, agentId: string, token: string) {
  const res = await postChannelMessage(
    new Request(`https://app.test/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: `@[Helper](${agentId}:page) read the Acme roadmap` }),
    }),
    { params: Promise.resolve({ pageId: channelId }) },
  );
  expect(res.status).toBeLessThan(300);
  // The responder runs after the response; its reply lands in the channel once the agent's turn settles.
  await vi.waitFor(async () => {
    const rows = await db.select({ content: channelMessages.content }).from(channelMessages)
      .where(and(eq(channelMessages.pageId, channelId), eq(channelMessages.isActive, true)));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  }, { timeout: 20_000, interval: 200 });
  return db.select({ content: channelMessages.content }).from(channelMessages).where(eq(channelMessages.pageId, channelId));
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('SEC-2 (partial) a channel @mention runs as the sender\'s credential (D-OW-62)', () => {
  it('SEC-2 (partial) a magic-link sender\'s mention cannot make an agent read a passkey-only org page; a passkey sender\'s can', async () => {
    const weak = await acme();
    const rows = await mention(weak.channel.id, weak.agent.id, await session(weak.person.id, { authenticatedAtMs: Date.now(), assurance: 'single_factor' }));
    expect(modelCalls.prompts.length).toBeGreaterThanOrEqual(2);
    const toolResultPrompt = modelCalls.prompts[1];
    expect(toolResultPrompt).not.toContain('ACME-ORG-SECRET');
    expect(toolResultPrompt).toContain('Insufficient permissions');
    expect(JSON.stringify(rows)).not.toContain('ACME-ORG-SECRET');

    const strong = await acme();
    const strongRows = await mention(strong.channel.id, strong.agent.id, await session(strong.person.id, { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' }));
    expect(modelCalls.prompts[1]).toContain('ACME-ORG-SECRET');
    expect(JSON.stringify(strongRows)).toContain('ACME-ORG-SECRET');
  }, 60_000);
});
