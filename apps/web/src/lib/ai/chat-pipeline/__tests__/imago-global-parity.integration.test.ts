// @vitest-environment node
/**
 * IMG-10.10 — Imago replaces the global assistant one for one: for the same
 * user, toggles and location, an Imago turn is handed the SAME tools and the
 * same context as a global-assistant turn.
 *
 * Both turns are driven for real: Imago through `POST /api/ai/chat` (the page
 * pipeline it runs on), the global assistant through
 * `POST /api/ai/global/[id]/messages`. Real: the session, Postgres, Imago
 * provisioning, integration connections, the whole tool selection and prompt
 * assembly, the AI SDK's `streamText`. Replaced: only the language model, by
 * the SDK's `MockLanguageModelV3`, which records the tool names and the prompt
 * the provider would have been sent.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import type { MockLanguageModelV3 } from 'ai/test';

type CallOptions = Parameters<MockLanguageModelV3['doStream']>[0];

interface Sent {
  toolNames: string[];
  system: string;
  lastUser: string;
}

const captured: Sent[] = [];

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/provider-factory')>();
  const { MockLanguageModelV3: Mock } = await import('ai/test');
  return {
    ...actual,
    createAIProvider: vi.fn(async () => ({
      model: new Mock({
        doStream: async (options: CallOptions) => {
          const users = options.prompt.filter((message) => message.role === 'user');
          const last = users[users.length - 1];
          captured.push({
            toolNames: (options.tools ?? []).map((tool) => tool.name).sort(),
            system: options.prompt.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
            lastUser: last && last.role === 'user'
              ? last.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
              : '',
          });
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
import { drives, pages } from '@pagespace/db/schema/core';
import { globalAssistantConfig, integrationConnections, integrationProviders } from '@pagespace/db/schema/integrations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { getBuiltinAgent } from '@pagespace/lib/agents/builtin-agents';
import type { IntegrationProviderConfig } from '@pagespace/lib/integrations/types';
import { buildAgentMemorySection } from '@/lib/ai/core/agent-memory';
import { buildLocationTurnPrompt } from '@/lib/ai/core/location-prompt';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { POST as postPageChat } from '@/app/api/ai/chat/route';
import { POST as postGlobalMessage } from '@/app/api/ai/global/[id]/messages/route';

const MARK = `parity${createId().slice(0, 10)}`;
const GLOBAL_PERSONA = 'You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.';
const seededUserIds: string[] = [];
const seededProviderIds: string[] = [];

interface World {
  token: string;
  userId: string;
  imagoPageId: string;
  ordinaryAgentPageId: string;
  acme: { driveId: string; pageId: string };
  journal: { driveId: string; pageId: string };
}

let world: World;

interface Toggles {
  isReadOnly?: boolean;
  webSearchEnabled?: boolean;
  imageGenEnabled?: boolean;
}

const providerConfig = (slug: string): IntegrationProviderConfig => ({
  id: slug,
  name: slug,
  authMethod: { type: 'none' },
  baseUrl: 'https://integration.invalid',
  tools: [{
    id: 'lookup',
    name: 'Lookup',
    description: 'Look something up.',
    category: 'read',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    execution: { type: 'http', config: { method: 'GET', pathTemplate: '/lookup' } },
  }],
});

async function connect(label: string, scope: { userId: string } | { driveId: string }): Promise<string> {
  const slug = `${MARK.toLowerCase()}-${label}`;
  const [provider] = await db
    .insert(integrationProviders)
    .values({ slug, name: slug, providerType: 'custom', config: providerConfig(slug) })
    .returning({ id: integrationProviders.id });
  seededProviderIds.push(provider.id);
  const [row] = await db
    .insert(integrationConnections)
    .values({ providerId: provider.id, name: slug, status: 'active', visibility: 'all_drives', ...scope })
    .returning({ id: integrationConnections.id });
  return row.id;
}

/**
 * One user with Imago, "Acme" (owned, a drive prompt, a page, an ordinary
 * agent with a narrow allowlist), "Journal" (owned, a drive prompt, Imago kept
 * out of it), a user integration and a drive integration on each drive.
 */
async function seedWorld(): Promise<World> {
  // A paid plan: the global surface admits the chosen model only on one.
  const user = await factories.createUser({ subscriptionTier: 'pro' });
  seededUserIds.push(user.id);
  await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const acme = await factories.createDrive(user.id, { name: `${MARK} Acme`, slug: `acme-${createId()}`, drivePrompt: `${MARK}-acme-prompt` });
  const journal = await factories.createDrive(user.id, { name: `${MARK} Journal`, slug: `journal-${createId()}`, drivePrompt: `${MARK}-journal-prompt` });
  const acmePage = await factories.createPage(acme.id, { title: `${MARK} launch plan`, type: 'DOCUMENT' });
  const journalPage = await factories.createPage(journal.id, { title: `${MARK} journal entry`, type: 'DOCUMENT' });
  const ordinary = await factories.createPage(acme.id, {
    title: 'Plain Agent',
    type: 'AI_CHAT',
    systemPrompt: null,
    enabledTools: ['read_page', 'list_pages'],
  });

  const { agents } = await provisionImagoAgents(user.id);
  expect((await setImagoDriveAccess(user.id, journal.id, false)).ok).toBe(true);

  const userConnection = await connect('user', { userId: user.id });
  await connect('acme', { driveId: acme.id });
  await connect('journal', { driveId: journal.id });
  await db.insert(globalAssistantConfig).values({
    userId: user.id,
    enabledUserIntegrations: [userConnection],
    driveOverrides: {},
    inheritDriveIntegrations: true,
  });

  return {
    token: await sessionService.createSession({ userId: user.id, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 }),
    userId: user.id,
    imagoPageId: agents.imago,
    ordinaryAgentPageId: ordinary.id,
    acme: { driveId: acme.id, pageId: acmePage.id },
    journal: { driveId: journal.id, pageId: journalPage.id },
  };
}

const headers = () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${world.token}`,
  'x-browser-session-id': 'browser-img-10-10-parity',
});

const message = () => [{ id: createId(), role: 'user', parts: [{ type: 'text', text: 'What can you do here?' }] }];

async function sentBy(response: Response): Promise<Sent> {
  expect(response.status, await response.clone().text().catch(() => '')).toBe(200);
  await response.text();
  await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0), { timeout: 15_000 });
  return captured[0];
}

/** One real page-chat turn on `chatId` (Imago, or an ordinary agent for the control). */
async function pageTurn(chatId: string, toggles: Toggles = {}, contextRef?: ContextRef): Promise<Sent> {
  captured.length = 0;
  return sentBy(await postPageChat(new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      messages: message(),
      chatId,
      conversationId: createId(),
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.4-nano',
      ...toggles,
      ...(contextRef ? { contextRef } : {}),
    }),
  })));
}

/** One real global-assistant turn, with the page tree on as Imago's page has it. */
async function globalTurn(toggles: Toggles = {}, contextRef?: ContextRef): Promise<Sent> {
  captured.length = 0;
  const conversationId = createId();
  return sentBy(await postGlobalMessage(
    new Request(`http://localhost/api/ai/global/${conversationId}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        messages: message(),
        conversationId,
        selectedProvider: 'openai',
        selectedModel: 'openai/gpt-5.4-nano',
        showPageTree: true,
        ...toggles,
        ...(contextRef ? { contextRef } : {}),
      }),
    }),
    { params: Promise.resolve({ id: conversationId }) },
  ));
}

/** The volatile LOCATION block of the last user message. */
const locationBlock = (lastUser: string): string => {
  const start = lastUser.indexOf('LOCATION (current, this turn):');
  if (start === -1) return '';
  const lines = lastUser.slice(start).split('\n');
  const end = lines.findIndex((line, index) => index > 0 && !line.startsWith('•'));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
};

/** What the global prompt becomes with Imago's persona, conversation and memory. */
const asImago = (globalSystem: string): string =>
  globalSystem
    .replace(GLOBAL_PERSONA, getBuiltinAgent('imago').systemPrompt)
    .replace('CONVERSATION TYPE: GLOBAL', `CONVERSATION TYPE: PAGE (Context: ${world.imagoPageId})`) +
  buildAgentMemorySection('');

vi.setConfig({ testTimeout: 60_000 });

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

describe('IMG-10.10 — Imago is handed exactly the global assistant\'s tools', () => {
  const acmeInView = (): ContextRef => ({ routeType: 'page', pageId: world.acme.pageId, driveId: world.acme.driveId });

  it.each<[string, Toggles]>([
    ['the default toggles', {}],
    ['read-only', { isReadOnly: true }],
    ['web search on', { webSearchEnabled: true }],
    ['read-only with web search on', { isReadOnly: true, webSearchEnabled: true }],
    ['image generation requested by a non-admin', { imageGenEnabled: true }],
  ])('given %s and no location, should hand Imago the same tool names as the global assistant', async (_label, toggles) => {
    const imago = await pageTurn(world.imagoPageId, toggles);
    const global = await globalTurn(toggles);

    expect(imago.toolNames).toEqual(global.toolNames);
    expect(global.toolNames).toEqual(expect.arrayContaining(['tool_search', 'execute_tool', 'finish', 'ask_user']));
  });

  it('given a drive in view, should hand Imago the same tool names — that drive\'s integrations included', async () => {
    const imago = await pageTurn(world.imagoPageId, {}, acmeInView());
    const global = await globalTurn({}, acmeInView());

    expect(imago.toolNames).toEqual(global.toolNames);
    expect(imago.toolNames.some((name) => name.includes(`${MARK.toLowerCase()}-acme`))).toBe(true);
  });

  it('negative control: given an ordinary agent with a narrow allowlist, should NOT match the global assistant — the comparison can fail', async () => {
    const ordinary = await pageTurn(world.ordinaryAgentPageId);
    const global = await globalTurn();

    expect(ordinary.toolNames).not.toEqual(global.toolNames);
  });
});

describe('IMG-10.10 — Imago is given the global assistant\'s context, plus its persona and Agent Memory', () => {
  it('given no location, should send the global assistant\'s system prompt with Imago\'s persona, conversation and memory', async () => {
    const imago = await pageTurn(world.imagoPageId);
    const global = await globalTurn();

    // The one difference: the all-drives summary leaves out the drive Imago is kept out of.
    const journalLine = `\n- ${MARK} Journal (id: ${world.journal.driveId})`;
    expect(global.system).toContain(journalLine);
    expect(imago.system).toBe(asImago(global.system).replace(journalLine, ''));
    expect(locationBlock(imago.lastUser)).toBe(locationBlock(global.lastUser));
  });

  it('given a drive in view, should carry the same drive prompt, drive tree and location as the global assistant', async () => {
    const ref: ContextRef = { routeType: 'page', pageId: world.acme.pageId, driveId: world.acme.driveId };
    const imago = await pageTurn(world.imagoPageId, {}, ref);
    const global = await globalTurn({}, ref);

    expect(global.system).toContain(`${MARK}-acme-prompt`);
    expect(global.system).toContain(`${MARK} launch plan`);
    expect(imago.system).toBe(asImago(global.system));
    expect(locationBlock(imago.lastUser)).toBe(locationBlock(global.lastUser));
  });

  it('given a drive the user keeps Imago out of in view, should drop its prompt, tree and name — where the global assistant keeps them', async () => {
    const ref: ContextRef = { routeType: 'page', pageId: world.journal.pageId, driveId: world.journal.driveId };
    const imago = await pageTurn(world.imagoPageId, {}, ref);
    const global = await globalTurn({}, ref);

    // Control: the global assistant, which nothing excludes, sees the drive.
    expect(global.system).toContain(`${MARK}-journal-prompt`);
    expect(global.system).toContain(`${MARK} journal entry`);
    for (const hidden of [`${MARK}-journal-prompt`, `${MARK} journal entry`, `${MARK} Journal`]) {
      expect(imago.system, hidden).not.toContain(hidden);
      expect(imago.lastUser, hidden).not.toContain(hidden);
    }
    // The excluded drive's LOCATION block is exactly the honest note the
    // `{ kind: 'excluded' }` access flag renders — nothing of the drive in it.
    expect(locationBlock(imago.lastUser)).toBe(
      buildLocationTurnPrompt({ currentDrive: { name: 'Drive' }, agentAccess: { kind: 'excluded' } }),
    );
    // The all-drives summary it falls back to still names the drives it may use.
    expect(imago.system).toContain(`${MARK} Acme`);
  });

  it("given Imago's own memory page, should carry it", async () => {
    const [imagoPage] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, world.imagoPageId));
    const memory = await factories.createPage(imagoPage.driveId, {
      title: 'Agent Memory',
      type: 'DOCUMENT',
      parentId: world.imagoPageId,
      content: `${MARK}-remembered`,
    });
    try {
      const imago = await pageTurn(world.imagoPageId);
      expect(imago.system).toContain(`${MARK}-remembered`);
    } finally {
      await db.delete(pages).where(eq(pages.id, memory.id));
    }
  });
});
