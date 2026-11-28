// @vitest-environment node
/**
 * IMG-4.9 AC4 beyond page chat — which integration tools a built-in Imago
 * agent is handed on every OTHER way it runs: the invoke-an-agent engine
 * (`executeAskAgent`, behind channel @-mentions), `POST /api/ai/page-agents/consult`
 * and a workflow run (`executeWorkflow`). All three resolve through
 * `resolvePageAgentIntegrationTools`, which must never hand an Imago agent its
 * per-agent `integration_tool_grants` (they may name a drive the user keeps it
 * out of), must draw drive integrations only from a drive it is not kept out
 * of (IMG-10.10), and must hand anyone but its owner nothing.
 *
 * Real: Postgres, the session, Imago provisioning, the per-drive setting, connections,
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
      // A free-tier-allowed model: this suite pins integration-tool scoping, not the
      // WAL-8/POL-8 payer gate (which its users, on free, would otherwise trip).
      modelName: 'openai/gpt-6-luna',
    })),
    updateUserProviderSettings: vi.fn(async () => undefined),
  };
});

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { wallets, walletConsumerCaps } from '@pagespace/db/schema/wallets';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { userConsumerKey } from '@pagespace/lib/billing/wallet-core';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import {
  globalAssistantConfig,
  integrationConnections,
  integrationProviders,
  integrationToolGrants,
} from '@pagespace/db/schema/integrations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import type { IntegrationProviderConfig } from '@pagespace/lib/integrations/types';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
// Before agent-communication-tools: it sits in a cycle with ai-tools' tool registry.
import { creditAdmission } from '@/lib/workflows/workflow-credit-gate';
import { executeWorkflow, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { executeAskAgent } from '@/lib/ai/tools/agent-communication-tools';
import { POST as consult } from '@/app/api/ai/page-agents/consult/route';

type ProviderKey = 'userEnabled' | 'ownedDrive' | 'excludedDrive' | 'memberDrive';

const seededUserIds: string[] = [];
const seededProviderIds: string[] = [];

interface World {
  userId: string;
  otherUserId: string;
  token: string;
  otherToken: string;
  imagoPageId: string;
  homeDriveId: string;
  ownedDriveId: string;
  excludedDriveId: string;
  memberDriveId: string;
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
 * The user's Home, "Acme" (owned) and "Journal" (owned, Imago kept out of
 * it), a user integration, a drive integration on each of Acme and
 * Journal, and — the trap — a per-agent grant on the Imago page itself for
 * Journal's connection, as `POST /api/agents/[agentId]/integrations` accepts.
 */
async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  seededUserIds.push(user.id, other.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });
  const [root] = await db.insert(wallets).values({ userId: user.id, monthlyRemainingCents: 100000 }).returning();
  await db.insert(wallets).values({ userId: other.id, monthlyRemainingCents: 100000 });
  const acme = await factories.createDrive(user.id, { name: 'Acme', slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: 'Journal', slug: `journal-${createId()}` });
  await factories.createDrive(other.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });
  // Automated integration tests enter through the real drive-wallet reservation,
  // including the creator's caps; personal credits cannot admit an automation.
  for (const drive of [acme, journal]) {
    const [wallet] = await db.insert(wallets).values({ userId: user.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: root.id, monthlyAllowanceCents: 10000 }).returning();
    await db.insert(walletConsumerCaps).values({ walletId: wallet.id, consumerKey: userConsumerKey(user.id), monthlyCapCents: 1000 });
  }
  // Another user's drive the user is a member of, where no grant was ever made.
  const team = await factories.createDrive(other.id, { name: 'Team', slug: `team-${createId()}` });
  await factories.createDriveMember(team.id, user.id, { role: 'MEMBER', acceptedAt: new Date() });

  const { agents } = await provisionImagoAgents(user.id);
  // The user keeps Imago out of Journal (IMG-10.10).
  expect((await setImagoDriveAccess(credentialActor(user.id, null), journal.id, false)).ok).toBe(true);
  // The other user can open the Imago page (a share), so they can consult it.
  await factories.createPagePermission(agents.imago, other.id);

  const userEnabled = await connect('userEnabled', { userId: user.id });
  const ownedDrive = await connect('ownedDrive', { driveId: acme.id });
  const excludedDrive = await connect('excludedDrive', { driveId: journal.id });
  const memberDrive = await connect('memberDrive', { driveId: team.id });

  await db.insert(globalAssistantConfig).values({
    userId: user.id,
    enabledUserIntegrations: [userEnabled.connectionId],
    driveOverrides: {},
    inheritDriveIntegrations: true,
  });
  await db.insert(integrationToolGrants).values({ agentId: agents.imago, connectionId: excludedDrive.connectionId });

  const session = (userId: string) =>
    sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 , authentication: null});

  return {
    userId: user.id,
    otherUserId: other.id,
    token: await session(user.id),
    otherToken: await session(other.id),
    imagoPageId: agents.imago,
    homeDriveId: home.id,
    ownedDriveId: acme.id,
    excludedDriveId: journal.id,
    memberDriveId: team.id,
    slugs: { userEnabled: userEnabled.slug, ownedDrive: ownedDrive.slug, excludedDrive: excludedDrive.slug, memberDrive: memberDrive.slug },
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
    accessActor: credentialActor(userId, null),
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

async function viaWorkflow(driveId: string, options: { reserve?: boolean; refusal?: RegExp } = {}): Promise<string[]> {
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
  const input: WorkflowExecutionInput = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    driveId,
    createdBy: world.userId,
    agentPageId: world.imagoPageId,
    prompt: workflow.prompt,
    contextPageIds: [],
    instructionPageId: null,
    timezone: 'UTC',
    source: { table: 'cron', id: null, triggerAt: null },
  };
  const acquire = creditAdmission(input, 'scheduled');
  const admit = async () => {
    const admission = await acquire();
    if (admission.admitted) {
      const [payer] = await db.select().from(wallets).where(eq(wallets.subjectId, driveId));
      expect(admission.creditSpend).toMatchObject({ walletId: payer.id, userId: world.userId, spend: { kind: 'automation', driveId } });
      const holds = await db.select().from(creditHolds).where(eq(creditHolds.walletId, payer.id));
      expect(holds).toHaveLength(1);
      expect(holds[0].userId).toBe(world.userId);
      expect(holds[0].estCents).toBeGreaterThan(0);
    }
    return admission;
  };
  const result = await executeWorkflow(input, options.reserve === false ? {} : { admit });
  await vi.waitFor(async () => expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, world.userId))).toEqual([]));
  if (options.refusal) {
    expect(result).toMatchObject({ success: false, skipped: true });
    expect(result.error).toMatch(options.refusal);
    expect(capturedToolNames).toEqual([]);
    return [];
  }
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

    it("given an owned drive in view, should add that drive's integrations", async () => {
      expect(await viaAskAgent(world.userId, world.ownedDriveId)).toEqual(['ownedDrive', 'userEnabled']);
    });

    it("given a drive the user keeps Imago out of in view, should never hand it that drive's integrations", async () => {
      expect(await viaAskAgent(world.userId, world.excludedDriveId)).toEqual(['userEnabled']);
    });

    it("given a drive the user is only a member of in view, should add that drive's integrations — the user's reach, no grant (IMG-10.10)", async () => {
      expect(await viaAskAgent(world.userId, world.memberDriveId)).toEqual(['memberDrive', 'userEnabled']);
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
    it("given a workflow in an owned drive, should hand it that drive's integrations and the user ones", async () => {
      expect(await viaWorkflow(world.ownedDriveId)).toEqual(['ownedDrive', 'userEnabled']);
    });

    it("given a workflow in a drive the user keeps Imago out of, should never hand it that drive's integrations", async () => {
      expect(await viaWorkflow(world.excludedDriveId)).toEqual(['userEnabled']);
    });
  });
});

it('negative control: a workflow with no reservation or an exhausted creator cap never calls the provider or bills personal credits', async () => {
  const before = await db.select().from(creditLedger).where(eq(creditLedger.userId, world.userId));
  const walletsBefore = await db.select().from(wallets).where(eq(wallets.userId, world.userId)).orderBy(wallets.id);
  expect(await viaWorkflow(world.ownedDriveId, { reserve: false, refusal: /no drive wallet reserved/ })).toEqual([]);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.subjectId, world.ownedDriveId));
  await db.update(walletConsumerCaps).set({ monthlyCapCents: 0 }).where(eq(walletConsumerCaps.walletId, wallet.id));
  expect(await viaWorkflow(world.ownedDriveId, { refusal: /cap/ })).toEqual([]);
  expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, world.userId))).toEqual(before);
  expect(await db.select().from(wallets).where(eq(wallets.userId, world.userId)).orderBy(wallets.id)).toEqual(walletsBefore);
});
