// @vitest-environment node
/**
 * IMG-4.8 — which integration tools a built-in Imago agent is handed, driven
 * through the REAL page-chat turn (`POST /api/ai/chat`) against a real
 * Postgres, on IMG-4.7's harness.
 *
 * Real: the session, the database, Imago provisioning and its drive grants,
 * the user's integration connections and `global_assistant_config`, the
 * resolution and conversion of integration tools, and the AI SDK's own
 * `streamText`. Replaced: only the language model, by the SDK's
 * `MockLanguageModelV3`, which records the tool names the provider would have
 * been sent. Nothing between the request and that list is mocked, so the
 * assertions are about what the model can actually call.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import type { MockLanguageModelV3 } from 'ai/test';

type CallOptions = Parameters<MockLanguageModelV3['doStream']>[0];

const capturedToolNames: string[][] = [];

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/provider-factory')>();
  const { MockLanguageModelV3: Mock } = await import('ai/test');
  return {
    ...actual,
    createAIProvider: vi.fn(async () => ({
      model: new Mock({
        doStream: async (options: CallOptions) => {
          capturedToolNames.push((options.tools ?? []).map((tool) => tool.name));
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
import {
  globalAssistantConfig,
  integrationConnections,
  integrationProviders,
  integrationToolGrants,
} from '@pagespace/db/schema/integrations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import type { IntegrationProviderConfig } from '@pagespace/lib/integrations/types';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { POST } from '@/app/api/ai/chat/route';

const seededUserIds: string[] = [];
const seededProviderIds: string[] = [];

/** One provider per connection, each with a single read tool `lookup`. */
type ProviderKey =
  | 'userEnabled'
  | 'userPrivate'
  | 'userNotEnabled'
  | 'grantedDrive'
  | 'ungrantedDrive'
  | 'memberDrive'
  | 'homeDrive';

interface World {
  userId: string;
  token: string;
  imagoPageId: string;
  ordinaryAgentPageId: string;
  homeDriveId: string;
  granted: { driveId: string; pageId: string };
  ungranted: { driveId: string };
  memberOnly: { driveId: string };
  slugs: Record<ProviderKey, string>;
  enabledUserIntegrations: string[];
}

let world: World;

const providerConfig = (slug: string): IntegrationProviderConfig => ({
  id: slug,
  name: slug,
  authMethod: { type: 'none' },
  baseUrl: 'https://integration.invalid',
  tools: [
    {
      id: 'lookup',
      name: 'Lookup',
      description: 'Look something up.',
      category: 'read',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      execution: { type: 'http', config: { method: 'GET', pathTemplate: '/lookup' } },
    },
  ],
});

async function createProvider(key: ProviderKey): Promise<string> {
  const slug = `img48-${key.toLowerCase()}-${createId().slice(0, 8)}`;
  const [row] = await db
    .insert(integrationProviders)
    .values({ slug, name: slug, providerType: 'custom', config: providerConfig(slug) })
    .returning({ id: integrationProviders.id });
  seededProviderIds.push(row.id);
  return slug;
}

async function connect(
  slug: string,
  scope: { userId: string } | { driveId: string },
  visibility: 'private' | 'owned_drives' | 'all_drives' = 'all_drives',
): Promise<string> {
  const [provider] = await db
    .select({ id: integrationProviders.id })
    .from(integrationProviders)
    .where(eq(integrationProviders.slug, slug));
  const [row] = await db
    .insert(integrationConnections)
    .values({ providerId: provider.id, name: slug, status: 'active', visibility, ...scope })
    .returning({ id: integrationConnections.id });
  return row.id;
}

/**
 * IMG-4.7's world — Home, "Acme Plans" (granted), "Private Journal" (owned,
 * grant removed), "Partner Ops" (the user is an ADMIN member, never granted)
 * and an ordinary agent in Acme — plus integrations:
 *   - three user connections: one enabled (all drives), one enabled but
 *     private, one the user left out of `enabledUserIntegrations`;
 *   - a drive connection on Home, on Acme, on Journal and on Partner;
 *   - the ordinary agent's own per-agent grant on the enabled user connection.
 */
async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  seededUserIds.push(user.id, other.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const acme = await factories.createDrive(user.id, { name: 'Acme Plans', slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: 'Private Journal', slug: `journal-${createId()}` });
  const partner = await factories.createDrive(other.id, { name: 'Partner Ops', slug: `partner-${createId()}` });
  await factories.createDriveMember(partner.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });

  const launch = await factories.createPage(acme.id, { title: 'Q4 Launch', type: 'DOCUMENT' });
  const ordinary = await factories.createPage(acme.id, {
    title: 'Plain Agent',
    type: 'AI_CHAT',
    systemPrompt: null,
    includePageTree: false,
    includeDrivePrompt: false,
  });

  const { agents } = await provisionImagoAgents(user.id);
  await db
    .delete(driveAgentMembers)
    .where(and(inArray(driveAgentMembers.agentPageId, Object.values(agents)), eq(driveAgentMembers.driveId, journal.id)));

  const slugs = {} as Record<ProviderKey, string>;
  for (const key of ['userEnabled', 'userPrivate', 'userNotEnabled', 'grantedDrive', 'ungrantedDrive', 'memberDrive', 'homeDrive'] as const) {
    slugs[key] = await createProvider(key);
  }
  const userEnabled = await connect(slugs.userEnabled, { userId: user.id });
  const userPrivate = await connect(slugs.userPrivate, { userId: user.id }, 'private');
  await connect(slugs.userNotEnabled, { userId: user.id });
  await connect(slugs.grantedDrive, { driveId: acme.id });
  await connect(slugs.ungrantedDrive, { driveId: journal.id });
  await connect(slugs.memberDrive, { driveId: partner.id });
  await connect(slugs.homeDrive, { driveId: home.id });

  const enabledUserIntegrations = [userEnabled, userPrivate];
  await db.insert(globalAssistantConfig).values({
    userId: user.id,
    enabledUserIntegrations,
    driveOverrides: {},
    inheritDriveIntegrations: true,
  });
  await db.insert(integrationToolGrants).values({ agentId: ordinary.id, connectionId: userEnabled });

  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    userId: user.id,
    token,
    imagoPageId: agents.imago,
    ordinaryAgentPageId: ordinary.id,
    homeDriveId: home.id,
    granted: { driveId: acme.id, pageId: launch.id },
    ungranted: { driveId: journal.id },
    memberOnly: { driveId: partner.id },
    slugs,
    enabledUserIntegrations,
  };
}

/** Run one real turn and return the integration providers the model was handed tools for. */
async function integrationsSent(chatId: string, contextRef?: ContextRef): Promise<string[]> {
  capturedToolNames.length = 0;
  const response = await POST(
    new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${world.token}`,
        'x-browser-session-id': 'browser-img-4-8',
      },
      body: JSON.stringify({
        messages: [{ id: createId(), role: 'user', parts: [{ type: 'text', text: 'What can you use?' }] }],
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
  await vi.waitFor(() => expect(capturedToolNames.length).toBeGreaterThan(0), { timeout: 10_000 });

  const keyBySlug = new Map(Object.entries(world.slugs).map(([key, slug]) => [slug, key]));
  return capturedToolNames[0]
    .filter((name) => name.startsWith('int__'))
    .map((name) => keyBySlug.get(name.slice('int__'.length).split('__')[0]) ?? name)
    .sort();
}

const setConfig = (values: Partial<typeof globalAssistantConfig.$inferInsert>) =>
  db.update(globalAssistantConfig).set(values).where(eq(globalAssistantConfig.userId, world.userId));

beforeAll(async () => {
  await ensureTestDb();
  world = await seedWorld();
}, 60_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await setConfig({ enabledUserIntegrations: world.enabledUserIntegrations, driveOverrides: {}, inheritDriveIntegrations: true });
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  if (seededProviderIds.length > 0) {
    await db.delete(integrationProviders).where(inArray(integrationProviders.id, seededProviderIds));
  }
});

describe('runPageChatTurn — Imago agent user integrations (IMG-4.8)', () => {
  it('given enabledUserIntegrations and no drive in view, should hand the Imago agent exactly the enabled user integrations', async () => {
    expect(await integrationsSent(world.imagoPageId)).toEqual(['userEnabled', 'userPrivate']);
  });

  it('given enabledUserIntegrations unset, should hand it every active user integration, as the global assistant does', async () => {
    await setConfig({ enabledUserIntegrations: null });

    expect(await integrationsSent(world.imagoPageId)).toEqual(['userEnabled', 'userNotEnabled', 'userPrivate']);
  });

  it("given a granted drive in view, should add that drive's integrations and apply drive visibility to user ones", async () => {
    const sent = await integrationsSent(world.imagoPageId, {
      routeType: 'page',
      pageId: world.granted.pageId,
      driveId: world.granted.driveId,
    });

    // `private` user integrations are hidden in a drive context, as for the global assistant.
    expect(sent).toEqual(['grantedDrive', 'userEnabled']);
  });

  it("given the Home drive in view, should add the Home drive's integrations", async () => {
    expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.homeDriveId })).toEqual([
      'homeDrive',
      'userEnabled',
    ]);
  });

  it('given a drive override switching drive integrations off, should drop them, as the global assistant does', async () => {
    await setConfig({ driveOverrides: { [world.granted.driveId]: { enabled: false } } });

    const sent = await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.granted.driveId });

    expect(sent).toEqual(['userEnabled']);
  });

  it('given an owned drive the agent is not granted, should never hand it that drive’s integrations', async () => {
    const sent = await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.ungranted.driveId });

    expect(sent).not.toContain('ungrantedDrive');
    expect(sent).toEqual(['userEnabled', 'userPrivate']);
  });

  it('given a drive the user is a member of but the agent is not granted, should never hand it that drive’s integrations', async () => {
    const sent = await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.memberOnly.driveId });

    expect(sent).not.toContain('memberDrive');
    expect(sent).toEqual(['userEnabled', 'userPrivate']);
  });

  it('given onprem mode, should hand the Imago agent no external integration at all', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');

    expect(await integrationsSent(world.imagoPageId)).toEqual([]);
    expect(
      await integrationsSent(world.imagoPageId, { routeType: 'page', pageId: world.granted.pageId, driveId: world.granted.driveId }),
    ).toEqual([]);
  });

  it('given an ordinary page agent, should hand it only its own per-agent grants, as before', async () => {
    const sent = await integrationsSent(world.ordinaryAgentPageId, {
      routeType: 'page',
      pageId: world.granted.pageId,
      driveId: world.granted.driveId,
    });

    expect(sent).toEqual(['userEnabled']);
  });
});
