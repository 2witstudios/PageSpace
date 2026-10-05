// @vitest-environment node
/**
 * IMG-4.9 AC4 beyond page chat — which integration tools a built-in Imago
 * agent is handed on every OTHER way it runs: the invoke-an-agent engine
 * (`executeAskAgent`, behind channel @-mentions), `POST /api/ai/page-agents/consult`
 * and a workflow run (`executeWorkflow`). All three resolve through
 * `resolvePageAgentIntegrationTools`, which must never hand an Imago agent its
 * per-agent `integration_tool_grants` (they may name a drive it holds no grant
 * on) and must draw drive integrations only from a granted drive.
 *
 * Real: Postgres, the session, Imago provisioning and grants, connections,
 * `global_assistant_config`, each entry point and the AI SDK. Replaced: only
 * the language model, which records the tool names it is handed.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import type { MockLanguageModelV3 } from 'ai/test';

type CallOptions = Parameters<MockLanguageModelV3['doGenerate']>[0];

const capturedToolNames: string[][] = [];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/provider-factory')>();
  const { MockLanguageModelV3: Mock } = await import('ai/test');
  const record = (options: CallOptions) => capturedToolNames.push((options.tools ?? []).map((tool) => tool.name));
  return {
    ...actual,
    createAIProvider: vi.fn(async () => ({
      model: new Mock({
        doGenerate: async (options: CallOptions) => {
          record(options);
          return {
            content: [{ type: 'text' as const, text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
            warnings: [],
          };
        },
        doStream: async (options: CallOptions) => {
          record(options);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
                controller.enqueue({ type: 'text-end', id: 't1' });
                controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
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
import { workflows } from '@pagespace/db/schema/workflows';
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
import type { ToolExecutionContext } from '@/lib/ai/core/types';
// Before agent-communication-tools: it sits in a cycle with ai-tools' tool registry.
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { executeAskAgent } from '@/lib/ai/tools/agent-communication-tools';
import { POST as consult } from '@/app/api/ai/page-agents/consult/route';

type ProviderKey = 'userEnabled' | 'grantedDrive' | 'ungrantedDrive';

const seededUserIds: string[] = [];
const seededProviderIds: string[] = [];

interface World {
  userId: string;
  otherUserId: string;
  token: string;
  otherToken: string;
  imagoPageId: string;
  homeDriveId: string;
  grantedDriveId: string;
  ungrantedDriveId: string;
  slugs: Record<ProviderKey, string>;
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

async function connect(key: ProviderKey, scope: { userId: string } | { driveId: string }): Promise<{ slug: string; connectionId: string }> {
  const slug = `img49e-${key.toLowerCase()}-${createId().slice(0, 8)}`;
  const [provider] = await db
    .insert(integrationProviders)
    .values({ slug, name: slug, providerType: 'custom', config: providerConfig(slug) })
    .returning({ id: integrationProviders.id });
  seededProviderIds.push(provider.id);
  const [connection] = await db
    .insert(integrationConnections)
    .values({ providerId: provider.id, name: slug, status: 'active', visibility: 'all_drives', ...scope })
    .returning({ id: integrationConnections.id });
  return { slug, connectionId: connection.id };
}

/**
 * The user's Home, "Acme" (owned, granted) and "Journal" (owned, grant
 * removed), a user integration, a drive integration on each of Acme and
 * Journal, and — the trap — a per-agent grant on the Imago page itself for
 * Journal's connection, as `POST /api/agents/[agentId]/integrations` accepts.
 */
async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  seededUserIds.push(user.id, other.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });
  const acme = await factories.createDrive(user.id, { name: 'Acme', slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: 'Journal', slug: `journal-${createId()}` });
  await factories.createDrive(other.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });

  const { agents } = await provisionImagoAgents(user.id);
  await db
    .delete(driveAgentMembers)
    .where(and(inArray(driveAgentMembers.agentPageId, Object.values(agents)), eq(driveAgentMembers.driveId, journal.id)));
  // The other user can open the Imago page (a share), so they can consult it.
  await factories.createPagePermission(agents.imago, other.id);

  const userEnabled = await connect('userEnabled', { userId: user.id });
  const grantedDrive = await connect('grantedDrive', { driveId: acme.id });
  const ungrantedDrive = await connect('ungrantedDrive', { driveId: journal.id });

  await db.insert(globalAssistantConfig).values({
    userId: user.id,
    enabledUserIntegrations: [userEnabled.connectionId],
    driveOverrides: {},
    inheritDriveIntegrations: true,
  });
  await db.insert(integrationToolGrants).values({ agentId: agents.imago, connectionId: ungrantedDrive.connectionId });

  const session = (userId: string) =>
    sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    userId: user.id,
    otherUserId: other.id,
    token: await session(user.id),
    otherToken: await session(other.id),
    imagoPageId: agents.imago,
    homeDriveId: home.id,
    grantedDriveId: acme.id,
    ungrantedDriveId: journal.id,
    slugs: { userEnabled: userEnabled.slug, grantedDrive: grantedDrive.slug, ungrantedDrive: ungrantedDrive.slug },
  };
}

/** The integration providers the model was handed tools for on its first call. */
function integrationsSent(): string[] {
  expect(capturedToolNames.length, 'the model was never called').toBeGreaterThan(0);
  const keyBySlug = new Map(Object.entries(world.slugs).map(([key, slug]) => [slug, key]));
  return capturedToolNames[0]
    .filter((name) => name.startsWith('int__'))
    .map((name) => keyBySlug.get(name.slice('int__'.length).split('__')[0]) ?? name)
    .sort();
}

async function viaAskAgent(userId: string, driveInView: string | null): Promise<string[]> {
  capturedToolNames.length = 0;
  const context: ToolExecutionContext = {
    userId,
    ...(driveInView ? { locationContext: { currentDrive: { id: driveInView, name: 'x', slug: 'x' } } } : {}),
  };
  const result = await executeAskAgent(
    { agentPath: '/Imago', agentId: world.imagoPageId, question: 'What can you use?' },
    { experimental_context: context },
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return integrationsSent();
}

async function viaConsult(token: string): Promise<string[]> {
  capturedToolNames.length = 0;
  const response = await consult(
    new Request('http://localhost/api/ai/page-agents/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentId: world.imagoPageId, question: 'What can you use?' }),
    }),
  );
  expect(response.status, await response.clone().text().catch(() => '')).toBe(200);
  await response.text();
  return integrationsSent();
}

async function viaWorkflow(driveId: string): Promise<string[]> {
  capturedToolNames.length = 0;
  const [workflow] = await db
    .insert(workflows)
    .values({
      id: createId(),
      driveId,
      createdBy: world.userId,
      name: 'IMG-4.9 workflow',
      agentPageId: world.imagoPageId,
      prompt: 'What can you use?',
      cronExpression: '0 9 * * 1',
      triggerType: 'cron',
      timezone: 'UTC',
      isEnabled: true,
    })
    .returning();
  const result = await executeWorkflow({
    workflowId: workflow.id,
    workflowName: workflow.name,
    driveId,
    createdBy: world.userId,
    agentPageId: world.imagoPageId,
    prompt: workflow.prompt,
    contextPageIds: [],
    instructionPageId: null,
    timezone: 'UTC',
    source: { table: 'manual', id: null, triggerAt: null },
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  return integrationsSent();
}

// Each case runs a real entry point end to end.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await ensureTestDb();
  world = await seedWorld();
}, 60_000);

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  if (seededProviderIds.length > 0) {
    await db.delete(integrationProviders).where(inArray(integrationProviders.id, seededProviderIds));
  }
});

describe('Imago agent integrations outside page chat (IMG-4.9 AC4)', () => {
  describe('executeAskAgent (channel @-mention engine)', () => {
    it('given no drive in view, should hand the Imago agent the user integrations and ignore its per-agent grants', async () => {
      expect(await viaAskAgent(world.userId, null)).toEqual(['userEnabled']);
    });

    it("given the granted drive in view, should add that drive's integrations", async () => {
      expect(await viaAskAgent(world.userId, world.grantedDriveId)).toEqual(['grantedDrive', 'userEnabled']);
    });

    it("given the ungranted drive in view, should never hand it that drive's integrations", async () => {
      expect(await viaAskAgent(world.userId, world.ungrantedDriveId)).toEqual(['userEnabled']);
    });
  });

  describe('POST /api/ai/page-agents/consult', () => {
    it('given the owner, should hand the Imago agent the user integrations and ignore its per-agent grants', async () => {
      expect(await viaConsult(world.token)).toEqual(['userEnabled']);
    });

    it("given another user who can open the Imago page, should hand it no integrations at all", async () => {
      expect(await viaConsult(world.otherToken)).toEqual([]);
    });
  });

  describe('executeWorkflow', () => {
    it("given a workflow in the granted drive, should hand it that drive's integrations and the user ones", async () => {
      expect(await viaWorkflow(world.grantedDriveId)).toEqual(['grantedDrive', 'userEnabled']);
    });

    it("given a workflow in the ungranted drive, should never hand it that drive's integrations", async () => {
      expect(await viaWorkflow(world.ungrantedDriveId)).toEqual(['userEnabled']);
    });
  });
});
