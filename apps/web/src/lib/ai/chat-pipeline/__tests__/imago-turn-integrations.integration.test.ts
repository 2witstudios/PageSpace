// @vitest-environment node
/**
 * IMG-4.8, reshaped by IMG-10.10 — which integration tools Imago is handed,
 * driven through the REAL page-chat turn (`POST /api/ai/chat`) against a real
 * Postgres. Imago gets the global assistant's integrations through the one
 * shared resolver: the user's, plus the drive in view's where the user is a
 * member — except a drive the user keeps Imago out of.
 *
 * Real: the session, the database, Imago provisioning, the per-drive setting,
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

/** Set to make the next Imago context load throw, as a failing query would. */
const imagoContextFailure = vi.hoisted(() => ({ next: null as Error | null }));

vi.mock('@/lib/ai/core/imago-agent-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/imago-agent-context')>();
  return {
    ...actual,
    loadImagoAgentContext: vi.fn(async (input: Parameters<typeof actual.loadImagoAgentContext>[0]) => {
      const failure = imagoContextFailure.next;
      imagoContextFailure.next = null;
      if (failure) throw failure;
      return actual.loadImagoAgentContext(input);
    }),
  };
});

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
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import {
  globalAssistantConfig,
  integrationConnections,
  integrationProviders,
  integrationToolGrants,
} from '@pagespace/db/schema/integrations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
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
  | 'ownedDrive'
  | 'excludedDrive'
  | 'memberDrive'
  | 'shareOnlyDrive'
  | 'homeDrive';

interface World {
  userId: string;
  token: string;
  imagoPageId: string;
  ordinaryAgentPageId: string;
  homeDriveId: string;
  owned: { driveId: string; pageId: string };
  excluded: { driveId: string };
  memberOnly: { driveId: string };
  shareOnly: { driveId: string; pageId: string };
  excludedDriveConnectionId: string;
  visitorToken: string;
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
 * The user's world — Home, "Acme Plans" (owned), "Private Journal" (owned,
 * Imago kept out of it), "Partner Ops" (the user is an ADMIN member), "Shared
 * Ops" (another user's drive the user reaches only through a page share) and
 * an ordinary agent in Acme — plus integrations:
 *   - three user connections: one enabled (all drives), one enabled but
 *     private, one the user left out of `enabledUserIntegrations`;
 *   - a drive connection on Home, Acme, Journal, Partner and Shared Ops;
 *   - the ordinary agent's own per-agent grant on the enabled user connection.
 * And a visitor who can open the user's Imago page through a page share.
 */
async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  const visitor = await factories.createUser();
  seededUserIds.push(user.id, other.id, visitor.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const acme = await factories.createDrive(user.id, { name: 'Acme Plans', slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: 'Private Journal', slug: `journal-${createId()}` });
  const partner = await factories.createDrive(other.id, { name: 'Partner Ops', slug: `partner-${createId()}` });
  await factories.createDriveMember(partner.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });
  const sharedOps = await factories.createDrive(other.id, { name: 'Shared Ops', slug: `shared-ops-${createId()}` });
  const sharedPage = await factories.createPage(sharedOps.id, { title: 'Shared Brief', type: 'DOCUMENT' });
  await factories.createPagePermission(sharedPage.id, user.id);

  const launch = await factories.createPage(acme.id, { title: 'Q4 Launch', type: 'DOCUMENT' });
  const ordinary = await factories.createPage(acme.id, {
    title: 'Plain Agent',
    type: 'AI_CHAT',
    systemPrompt: null,
    includePageTree: false,
    includeDrivePrompt: false,
  });

  const { agents } = await provisionImagoAgents(user.id);
  expect((await setImagoDriveAccess(user.id, journal.id, false)).ok).toBe(true);
  await factories.createPagePermission(agents.imago, visitor.id, { canEdit: true });

  const slugs = {} as Record<ProviderKey, string>;
  for (const key of ['userEnabled', 'userPrivate', 'userNotEnabled', 'ownedDrive', 'excludedDrive', 'memberDrive', 'shareOnlyDrive', 'homeDrive'] as const) {
    slugs[key] = await createProvider(key);
  }
  const userEnabled = await connect(slugs.userEnabled, { userId: user.id });
  const userPrivate = await connect(slugs.userPrivate, { userId: user.id }, 'private');
  await connect(slugs.userNotEnabled, { userId: user.id });
  await connect(slugs.ownedDrive, { driveId: acme.id });
  const excludedDriveConnectionId = await connect(slugs.excludedDrive, { driveId: journal.id });
  await connect(slugs.memberDrive, { driveId: partner.id });
  await connect(slugs.shareOnlyDrive, { driveId: sharedOps.id });
  await connect(slugs.homeDrive, { driveId: home.id });

  const enabledUserIntegrations = [userEnabled, userPrivate];
  await db.insert(globalAssistantConfig).values({
    userId: user.id,
    enabledUserIntegrations,
    driveOverrides: {},
    inheritDriveIntegrations: true,
  });
  await db.insert(integrationToolGrants).values({ agentId: ordinary.id, connectionId: userEnabled });

  const session = (userId: string) =>
    sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    userId: user.id,
    token: await session(user.id),
    visitorToken: await session(visitor.id),
    imagoPageId: agents.imago,
    ordinaryAgentPageId: ordinary.id,
    homeDriveId: home.id,
    owned: { driveId: acme.id, pageId: launch.id },
    excluded: { driveId: journal.id },
    memberOnly: { driveId: partner.id },
    shareOnly: { driveId: sharedOps.id, pageId: sharedPage.id },
    excludedDriveConnectionId,
    slugs,
    enabledUserIntegrations,
  };
}

/** POST one real turn to the page-chat route. */
function postTurn(chatId: string, contextRef?: ContextRef, token = world.token): Promise<Response> {
  return POST(
    new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
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
}

/** Run one real turn and return the integration providers the model was handed tools for. */
async function integrationsSent(chatId: string, contextRef?: ContextRef, token?: string): Promise<string[]> {
  capturedToolNames.length = 0;
  const response = await postTurn(chatId, contextRef, token);
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

/** Give the Imago page itself a per-agent grant on the excluded drive's connection. */
const grantImagoPagePerAgent = () =>
  db.insert(integrationToolGrants).values({ agentId: world.imagoPageId, connectionId: world.excludedDriveConnectionId });

afterEach(async () => {
  vi.unstubAllEnvs();
  imagoContextFailure.next = null;
  await db.delete(integrationToolGrants).where(eq(integrationToolGrants.agentId, world.imagoPageId));
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

describe("runPageChatTurn — Imago's integrations are the global assistant's (IMG-4.8, IMG-10.10)", () => {
  it('given enabledUserIntegrations and no drive in view, should hand Imago exactly the enabled user integrations', async () => {
    expect(await integrationsSent(world.imagoPageId)).toEqual(['userEnabled', 'userPrivate']);
  });

  it('given enabledUserIntegrations unset, should hand it every active user integration, as the global assistant does', async () => {
    await setConfig({ enabledUserIntegrations: null });

    expect(await integrationsSent(world.imagoPageId)).toEqual(['userEnabled', 'userNotEnabled', 'userPrivate']);
  });

  it("given an owned drive in view, should add that drive's integrations and apply drive visibility to user ones", async () => {
    const sent = await integrationsSent(world.imagoPageId, {
      routeType: 'page',
      pageId: world.owned.pageId,
      driveId: world.owned.driveId,
    });

    // `private` user integrations are hidden in a drive context, as for the global assistant.
    expect(sent).toEqual(['ownedDrive', 'userEnabled']);
  });

  it("given a drive the user is a member of in view, should add that drive's integrations — the user's reach, no grant needed", async () => {
    expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.memberOnly.driveId })).toEqual([
      'memberDrive',
      'userEnabled',
    ]);
  });

  it("given the Home drive in view, should add the Home drive's integrations", async () => {
    expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.homeDriveId })).toEqual([
      'homeDrive',
      'userEnabled',
    ]);
  });

  it('given a drive override switching drive integrations off, should drop them, as the global assistant does', async () => {
    await setConfig({ driveOverrides: { [world.owned.driveId]: { enabled: false } } });

    const sent = await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.owned.driveId });

    expect(sent).toEqual(['userEnabled']);
  });

  it('given a drive the user keeps Imago out of in view, should never hand it that drive’s integrations', async () => {
    const sent = await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.excluded.driveId });

    expect(sent).not.toContain('excludedDrive');
    expect(sent).toEqual(['userEnabled', 'userPrivate']);
  });

  it('negative control: given the same drive let back in, should hand it that drive’s integrations', async () => {
    expect((await setImagoDriveAccess(world.userId, world.excluded.driveId, true)).ok).toBe(true);
    try {
      expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.excluded.driveId })).toEqual([
        'excludedDrive',
        'userEnabled',
      ]);
    } finally {
      expect((await setImagoDriveAccess(world.userId, world.excluded.driveId, false)).ok).toBe(true);
    }
  });

  it("given a per-agent integration grant on the Imago page, should ignore it — with or without a drive in view", async () => {
    await grantImagoPagePerAgent();

    expect(await integrationsSent(world.imagoPageId)).toEqual(['userEnabled', 'userPrivate']);
    expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.owned.driveId })).toEqual([
      'ownedDrive',
      'userEnabled',
    ]);
    expect(await integrationsSent(world.imagoPageId, { routeType: 'drive', driveId: world.excluded.driveId })).toEqual([
      'userEnabled',
      'userPrivate',
    ]);
  });

  it('given a drive the user reaches only through a page share, should hand it none of that drive’s integrations', async () => {
    const sent = await integrationsSent(world.imagoPageId, {
      routeType: 'page',
      pageId: world.shareOnly.pageId,
      driveId: world.shareOnly.driveId,
    });

    // No drive membership, so no drive context: user integrations follow the dashboard rules.
    expect(sent).toEqual(['userEnabled', 'userPrivate']);
  });

  it('given the Imago context fails to load, should fail the turn closed instead of falling back to per-agent grants', async () => {
    await grantImagoPagePerAgent();
    imagoContextFailure.next = new Error('connection reset');
    capturedToolNames.length = 0;

    const response = await postTurn(world.imagoPageId);

    expect(response.status).toBe(500);
    await response.text();
    // The model was never called, so it was never handed the excluded drive's tools.
    expect(capturedToolNames).toEqual([]);
  });

  it('given onprem mode, should hand Imago no external integration at all', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');

    expect(await integrationsSent(world.imagoPageId)).toEqual([]);
    expect(
      await integrationsSent(world.imagoPageId, { routeType: 'page', pageId: world.owned.pageId, driveId: world.owned.driveId }),
    ).toEqual([]);
  });

  it("given a visitor running the user's Imago page, should hand it no integration — not the visitor's, not the owner's", async () => {
    capturedToolNames.length = 0;
    const response = await postTurn(world.imagoPageId, undefined, world.visitorToken);
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(capturedToolNames.length).toBeGreaterThan(0), { timeout: 10_000 });

    expect(capturedToolNames[0].filter((name) => name.startsWith('int__'))).toEqual([]);
  });

  it('given an ordinary page agent, should hand it only its own per-agent grants, as before', async () => {
    const sent = await integrationsSent(world.ordinaryAgentPageId, {
      routeType: 'page',
      pageId: world.owned.pageId,
      driveId: world.owned.driveId,
    });

    expect(sent).toEqual(['userEnabled']);
  });
});
