// @vitest-environment node
/**
 * IMG-4.7 — what a built-in Imago agent is told about its reach and the
 * user's location, driven through the REAL page-chat turn (`POST /api/ai/chat`)
 * against a real Postgres.
 *
 * Real: the session (minted by the session service, sent as a Bearer token),
 * the database, Imago provisioning and its drive grants, the permission checks
 * behind the context ref, the whole prompt assembly and the AI SDK's own
 * `streamText`. Replaced: only the language model, by the SDK's
 * `MockLanguageModelV3`, which records the exact prompt the provider would
 * have been sent — the system message and the last user message, where the
 * per-turn location block rides. Nothing between the request and that prompt
 * is mocked, so the assertions are about what the model actually reads.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

const capturedPrompts: LanguageModelV3CallOptions['prompt'][] = [];

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/provider-factory')>();
  const { MockLanguageModelV3: Mock } = await import('ai/test');
  return {
    ...actual,
    createAIProvider: vi.fn(async () => ({
      model: new Mock({
        doStream: async (options: LanguageModelV3CallOptions) => {
          capturedPrompts.push(options.prompt);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
                controller.enqueue({ type: 'text-end', id: 't1' });
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      }),
      provider: 'ollama',
      modelName: 'mock-model',
    })),
    updateUserProviderSettings: vi.fn(async () => undefined),
  };
});

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { POST } from '@/app/api/ai/chat/route';

void MockLanguageModelV3;

const seededUserIds: string[] = [];

interface World {
  token: string;
  imagoPageId: string;
  homeDriveId: string;
  granted: { driveId: string; pageId: string };
  ungranted: { driveId: string };
  memberOnly: { driveId: string };
  foreign: { pageId: string };
  ordinaryAgentPageId: string;
}

let world: World;

/**
 * One user with Imago provisioned and four drives around them:
 *   - "Acme Plans": owned, granted to the Imago agents by provisioning;
 *   - "Private Journal": owned, grant removed (the per-drive toggle switched off);
 *   - "Partner Ops": someone else's, the user is an ADMIN member — never granted;
 *   - "Rival Co": someone else's, the user has no access at all.
 * Plus an ordinary agent in "Acme Plans" with a membership of its own.
 */
async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  seededUserIds.push(user.id, other.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const acme = await factories.createDrive(user.id, { name: 'Acme Plans', slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: 'Private Journal', slug: `journal-${createId()}` });
  const partner = await factories.createDrive(other.id, { name: 'Partner Ops', slug: `partner-${createId()}` });
  const rival = await factories.createDrive(other.id, { name: 'Rival Co', slug: `rival-${createId()}` });
  await factories.createDriveMember(partner.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });

  const launch = await factories.createPage(acme.id, { title: 'Q4 Launch', type: 'DOCUMENT' });
  const secret = await factories.createPage(rival.id, { title: 'Secret Roadmap', type: 'DOCUMENT' });
  const ordinary = await factories.createPage(acme.id, {
    title: 'Plain Agent',
    type: 'AI_CHAT',
    systemPrompt: null,
    includePageTree: false,
    includeDrivePrompt: false,
  });
  // An ordinary agent with a drive membership of its own: if the Imago summary
  // ever leaked to non-Imago agents, this is where it would show.
  await db.insert(driveAgentMembers).values({ driveId: journal.id, agentPageId: ordinary.id, role: 'MEMBER' });

  const { agents } = await provisionImagoAgents(user.id);
  // The user switched Imago off for "Private Journal".
  await db
    .delete(driveAgentMembers)
    .where(and(inArray(driveAgentMembers.agentPageId, Object.values(agents)), eq(driveAgentMembers.driveId, journal.id)));

  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    token,
    imagoPageId: agents.imago,
    homeDriveId: home.id,
    granted: { driveId: acme.id, pageId: launch.id },
    ungranted: { driveId: journal.id },
    memberOnly: { driveId: partner.id },
    foreign: { pageId: secret.id },
    ordinaryAgentPageId: ordinary.id,
  };
}

interface SentPrompt {
  system: string;
  lastUser: string;
}

/** Run one real turn and return exactly what the model was sent. */
async function turn(chatId: string, contextRef?: ContextRef): Promise<SentPrompt> {
  capturedPrompts.length = 0;
  const response = await POST(
    new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${world.token}`,
        'x-browser-session-id': 'browser-img-4-7',
      },
      body: JSON.stringify({
        messages: [{ id: createId(), role: 'user', parts: [{ type: 'text', text: 'What can you see?' }] }],
        chatId,
        conversationId: createId(),
        selectedProvider: 'openai',
        selectedModel: 'openai/gpt-5.4-nano',
        ...(contextRef ? { contextRef } : {}),
      }),
    }),
  );
  expect(response.status, await response.clone().text().catch(() => '')).toBe(200);
  await response.text();
  await vi.waitFor(() => expect(capturedPrompts.length).toBeGreaterThan(0), { timeout: 10_000 });

  const prompt = capturedPrompts[0];
  const system = prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const users = prompt.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  const lastUser = last && last.role === 'user'
    ? last.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
    : '';
  return { system, lastUser };
}

/** The granted-workspaces block of the system prompt, or '' when absent. */
const grantedSection = (system: string): string => {
  const start = system.indexOf('## GRANTED WORKSPACES');
  if (start === -1) return '';
  const next = system.indexOf('\n## ', start + 1);
  return next === -1 ? system.slice(start) : system.slice(start, next);
};

/** The volatile LOCATION block, ids normalized so it can be snapshotted. */
const locationBlock = (lastUser: string): string => {
  const start = lastUser.indexOf('LOCATION (current, this turn):');
  if (start === -1) return '';
  const lines = lastUser.slice(start).split('\n');
  const end = lines.findIndex((line, i) => i > 0 && !line.startsWith('•'));
  return (end === -1 ? lines : lines.slice(0, end))
    .join('\n')
    .replace(/(pageId|driveId): [a-z0-9]+/g, '$1: <id>')
    .replace(/slug: [a-z0-9-]+/g, 'slug: <slug>')
    .replace(/at \/[a-z0-9-]+\//g, 'at /<slug>/');
};

beforeAll(async () => {
  await ensureTestDb();
  world = await seedWorld();
}, 60_000);

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('runPageChatTurn — Imago agent drive and location context (IMG-4.7)', () => {
  it('given a built-in Imago agent, should tell it the drives it is granted, by name and role, and nothing else', async () => {
    const { system } = await turn(world.imagoPageId, {
      routeType: 'page',
      pageId: world.granted.pageId,
      driveId: world.granted.driveId,
    });

    const section = grantedSection(system);
    expect(section).toContain('"Acme Plans" — MEMBER');
    // Owned but ungranted, member-only and foreign drives are not the agent's reach.
    expect(system).not.toContain('Private Journal');
    expect(system).not.toContain('Partner Ops');
    expect(system).not.toContain('Rival Co');
    // Names and roles only: no ids in the summary.
    expect(section).not.toContain(world.granted.driveId);
  });

  it("given a context ref to a granted drive's page, should carry the location hint and say the agent may work there", async () => {
    const { lastUser } = await turn(world.imagoPageId, {
      routeType: 'page',
      pageId: world.granted.pageId,
      driveId: world.granted.driveId,
    });

    expect(lastUser).toContain('• Current page: "Q4 Launch" [DOCUMENT]');
    expect(lastUser).toContain('• Current workspace: "Acme Plans"');
    expect(lastUser).toContain('• Your access here: granted (MEMBER)');
  });

  it('given a context ref to an owned drive the agent is not granted, should say it cannot work there', async () => {
    const { lastUser } = await turn(world.imagoPageId, { routeType: 'drive', driveId: world.ungranted.driveId });

    expect(lastUser).toContain('• Current workspace: "Private Journal"');
    expect(lastUser).toContain('• Your access here: not granted');
    // The "act on THIS workspace" defaults would send the agent at a drive it cannot reach.
    expect(lastUser).not.toContain('to act on THIS workspace');
  });

  it('given a context ref to a page the user cannot view, should ignore it entirely', async () => {
    const { system, lastUser } = await turn(world.imagoPageId, { routeType: 'page', pageId: world.foreign.pageId });

    expect(`${system}\n${lastUser}`).not.toContain('Secret Roadmap');
    expect(`${system}\n${lastUser}`).not.toContain('Rival Co');
    expect(lastUser).toContain('• Operating from the dashboard');
    expect(lastUser).not.toContain('Your access here');
  });

  it('given an ordinary page agent, should leave its prompt unchanged', async () => {
    const { system, lastUser } = await turn(world.ordinaryAgentPageId, {
      routeType: 'page',
      pageId: world.granted.pageId,
      driveId: world.granted.driveId,
    });

    expect(grantedSection(system)).toBe('');
    expect(lastUser).not.toContain('Your access here');
    expect(system).toMatchSnapshot('ordinary agent system prompt');
    expect(locationBlock(lastUser)).toMatchSnapshot('ordinary agent location block');
  });
});
