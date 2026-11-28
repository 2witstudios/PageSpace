/**
 * POL-8 against a REAL Postgres: an org's model and provider allowlists govern every model use inside its drives,
 * read from the org row at the moment of use (no cache), and nothing outside its drives.
 *   - running a model: the provider factory refuses a model or provider the drive's org does not allow, including a
 *     call that used to name no drive (the Zoom summary, billed to the meeting's destination drive);
 *   - saving one: an agent page's provider/model write (every route, AI tool and chat echo goes through
 *     applyPageMutation) and an agent page created with a chosen model are refused, and nothing is written;
 *   - offering one: the model list a drive's picker gets is the org's allowlist;
 *   - reading org content with one: a person's background model (memory discovery, pulse) leaves out the drives,
 *     and the pages in them, whose org does not allow it;
 *   - bringing one in: moving an agent page, or a whole drive, into an org that does not allow its model is refused;
 *   - consulting one: ask_agent sends an agent's own drive content to its model, so the AGENT's org governs it as well
 *     as the caller's, whoever calls (the global assistant, or an agent in another org's drive);
 *   - tools reading org content: a chat's tools (global assistant included) cannot read pages or drives of an org that
 *     does not allow the model running the chat;
 *   - generating images: the image model is built through the provider factory and judged by the same allowlists.
 * Only the model network call (`generateText`), page-version blob storage and the request's session are stubbed;
 * every policy, drive, page and user row is real. Every row is deleted; the pool is ended. The payer-aware tier the
 * shared pro-model gate (model-entitlement.ts) asks for is proven against real wallets in lib
 * (billing/__tests__/entitlement-tier.integration.test.ts), where organizations can be switched on.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'test-version', contentRef: 'test-ref', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:test-${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
// A model run's tool loop, as generateText runs it: when the run hands the model `read_page`, the stub calls it once
// with the run's own tool context (as the SDK would) on the page `toolRead.pageId` names, and records the outcome.
const toolRead = vi.hoisted(() => ({ pageId: '', outcomes: [] as string[] }));
interface StubTool { execute?: (args: unknown, options: { toolCallId: string; messages: never[]; experimental_context: unknown }) => Promise<unknown> }
interface StubRun { tools?: Record<string, StubTool>; experimental_context?: unknown }
const generateText = vi.hoisted(() => vi.fn(async (run?: StubRun) => {
  const readPage = run?.tools?.read_page?.execute;
  if (readPage && toolRead.pageId) {
    toolRead.outcomes.push(await readPage({ title: 'Plan', pageId: toolRead.pageId }, { toolCallId: 't', messages: [], experimental_context: run?.experimental_context })
      .then((result) => JSON.stringify(result), (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { text: '- decided', usage: { inputTokens: 1, outputTokens: 1 }, totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{ text: '- decided', toolCalls: [] }] };
}));
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText }));
// The bulk-copy route authenticates the drive owner's session; every permission check after that is real.
const authed = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: authed.userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 })),
  isAuthError: vi.fn(() => false),
}));
// Organizations are live for this app's own reads (the move-in route answers); the lib dist reads its own constant.
vi.mock('@/lib/websocket', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/websocket')>()), broadcastPageEvent: vi.fn(async () => undefined) }));

import { createAIProvider, isProviderError, orgModelRefusal } from '../provider-factory';
import { REALTIME_MODEL_VENDOR, resolveRealtimeModel } from '@/lib/ai/realtime/session';
import { resolveProviderModel } from '../ai-providers-config';
import { memberDrivesReadableByModel, offeredModels, scopeReadableByModel } from '../org-model-policy';
import { applyPageMutation, OrgModelPolicyError } from '@/services/api/page-mutation-service';
import { pageService } from '@/services/api/page-service';
import { generateTranscriptSummary } from '@/lib/integrations/zoom/generate-summary';
import { POST as bulkCopy } from '@/app/api/pages/bulk-copy/route';
import { POST as consult } from '@/app/api/ai/page-agents/consult/route';
import { PUT as moveDriveIn } from '@/app/api/drives/[driveId]/org/route';
import { movePagesToDrive } from '@/services/api/page-cross-drive-move-service';
// The tool registry first: entering through one tool module would close an import cycle back into it half-built.
import '@/lib/ai/core/ai-tools';
import { executeAskAgent } from '@/lib/ai/tools/agent-communication-tools';
import { canActorAccessDrive, canActorViewPage, getActorAccessiblePagesInDrive } from '@/lib/ai/tools/actor-permissions';
import { pageReadTools } from '@/lib/ai/tools/page-read-tools';
import { createImageProvider } from '../provider-factory';
import { DEFAULT_MODEL } from '../ai-providers-config';
import { DEFAULT_IMAGE_MODEL } from '../model-capabilities';
import { driveSpend } from '@pagespace/lib/billing/spend-target';
import type { ToolExecutionContext } from '../types';
import { commands } from '@pagespace/db/schema/commands';
import { skillTools } from '@/lib/ai/tools/skill-tools';
import { planCommandExecutions } from '../command-resolver';
import { commandsForModel } from '../command-model-policy';
import { toolModelContext } from '../tool-model-context';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let dbAvailable = false;
const originalKey = process.env.OPENROUTER_DEFAULT_API_KEY;

// The two models of the test, both in the static catalog under the same vendor.
const ALLOWED = { provider: 'openai', model: 'openai/gpt-6-luna' };
const REFUSED = { provider: 'openai', model: 'openai/gpt-6-sol' };

interface World { owner: string; orgId: string; orgDrive: string; agentPage: string; orgDocPage: string; personalDrive: string }
let w: World;

const setPolicies = (policies: Record<string, unknown>) => db.update(organizations).set({ policies }).where(eq(organizations.id, w.orgId));
const agentRow = async () => (await db.select({ aiProvider: pages.aiProvider, aiModel: pages.aiModel }).from(pages).where(eq(pages.id, w.agentPage)))[0];
const saveModel = (pair: { provider: string; model: string }) => applyPageMutation({
  pageId: w.agentPage,
  operation: 'agent_config_update',
  updates: { aiProvider: pair.provider, aiModel: pair.model },
  updatedFields: ['aiProvider', 'aiModel'],
  context: { userId: w.owner, resourceType: 'agent' },
});

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('org-model-policy.integration.test.ts', error);
  }
});

beforeEach(async () => {
  process.env.OPENROUTER_DEFAULT_API_KEY = 'test-key';
  generateText.mockClear();
  toolRead.pageId = '';
  toolRead.outcomes = [];
  if (!dbAvailable) return;
  const owner = await factories.createUser({ currentAiProvider: ALLOWED.provider, currentAiModel: ALLOWED.model });
  created.userIds.push(owner.id);
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, policies: { modelAllowlist: [ALLOWED.model] } });
  await db.insert(orgMembers).values({ orgId, userId: owner.id, role: 'OWNER' });
  await factories.createOrgSubscription(orgId, { status: 'active' });
  const orgDrive = (await factories.createDrive(owner.id, { orgId, orgVisibility: 'RESTRICTED' })).id;
  const personalDrive = (await factories.createDrive(owner.id)).id;
  created.driveIds.push(orgDrive, personalDrive);
  const agentPage = (await factories.createPage(orgDrive, { type: 'AI_CHAT', aiProvider: ALLOWED.provider, aiModel: ALLOWED.model })).id;
  const orgDocPage = (await factories.createPage(orgDrive)).id;
  w = { owner: owner.id, orgId, orgDrive, agentPage, orgDocPage, personalDrive };
  authed.userId = owner.id;
});

afterEach(async () => {
  if (originalKey === undefined) delete process.env.OPENROUTER_DEFAULT_API_KEY;
  else process.env.OPENROUTER_DEFAULT_API_KEY = originalKey;
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('transitive model source admission', () => {
  it('Given a memory page whose retained org forbids the model, should omit it even from a personal drive', async () => {
    const memoryPage = await factories.createPage(w.personalDrive);
    await db.insert(userPersonalization).values({ userId: w.owner, bioPageId: memoryPage.id, memoryOrgIds: [w.orgId] });
    await setPolicies({ providerAllowlist: [] });
    expect(await scopeReadableByModel({ provider: ALLOWED.provider, modelId: ALLOWED.model }, { driveIds: [w.personalDrive], pageIds: [memoryPage.id] }))
      .toEqual({ driveIds: [w.personalDrive], pageIds: [] });
    await setPolicies({ providerAllowlist: [ALLOWED.provider] });
    expect((await scopeReadableByModel({ provider: ALLOWED.provider, modelId: ALLOWED.model }, { driveIds: [w.personalDrive], pageIds: [memoryPage.id] })).pageIds)
      .toEqual([memoryPage.id]);
  });
});

describe('POL-8 the org model and provider allowlists govern every model use in its drives: running, saving, copying, moving in, offering and reading', () => {
  it('running: a model or provider the drive\'s org does not allow is refused 403 naming the policy; an allowed one runs; no drive, or a personal drive, is never restricted', async () => {
    const run = (driveId: string | null, pair: { provider: string; model: string }) =>
      createAIProvider(w.owner, { selectedProvider: pair.provider, selectedModel: pair.model }, { driveId });

    expect(await run(w.orgDrive, REFUSED)).toMatchObject({ status: 403, code: 'org_policy', policy: 'modelAllowlist' });
    expect(isProviderError(await run(w.orgDrive, ALLOWED))).toBe(false);
    expect(isProviderError(await run(w.personalDrive, REFUSED))).toBe(false);
    expect(isProviderError(await run(null, REFUSED))).toBe(false);

    await setPolicies({ providerAllowlist: ['anthropic'] });
    expect(await run(w.orgDrive, ALLOWED)).toMatchObject({ status: 403, policy: 'providerAllowlist' });
  });

  it('running: a change applies to the very next call, in both directions, with no restart', async () => {
    const run = () => createAIProvider(w.owner, { selectedProvider: REFUSED.provider, selectedModel: REFUSED.model }, { driveId: w.orgDrive });
    expect(isProviderError(await run())).toBe(true);
    await setPolicies({});
    expect(isProviderError(await run())).toBe(false);
    await setPolicies({ modelAllowlist: [] });
    expect(isProviderError(await run())).toBe(true);
  });

  it('running: a Zoom summary billed to an org drive uses only a model that org allows — refused, no model is called', async () => {
    const zoom = () => generateTranscriptSummary(w.owner, 'transcript', { driveId: w.orgDrive, userId: w.owner });
    const { provider, model } = resolveProviderModel(undefined, undefined, ALLOWED.provider, ALLOWED.model);

    await setPolicies({ modelAllowlist: [REFUSED.model] });
    expect(await zoom()).toBe('');
    expect(generateText).not.toHaveBeenCalled();

    await setPolicies({ modelAllowlist: [model], providerAllowlist: [provider] });
    expect(await zoom()).toBe('- decided');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('voice: a realtime call in an org drive is judged by the realtime model and its vendor (D-OW-65) before the handshake — refused where the org does not allow them, allowed where it does', async () => {
    const realtime = { modelId: resolveRealtimeModel({}), provider: REALTIME_MODEL_VENDOR };
    await setPolicies({ providerAllowlist: ['anthropic'] });
    expect(await orgModelRefusal([w.orgDrive], [realtime])).toMatchObject({ status: 403, code: 'org_policy', policy: 'providerAllowlist' });
    await setPolicies({ providerAllowlist: ['openai'], modelAllowlist: [realtime.modelId] });
    expect(await orgModelRefusal([w.orgDrive], [realtime])).toBeNull();
    // No drive (a personal call) is never restricted.
    await setPolicies({ providerAllowlist: ['anthropic'] });
    expect(await orgModelRefusal([null], [realtime])).toBeNull();
    // A Global Assistant call's replayed history (it carries no drive) reaches the model only when EVERY org the person
    // is in allows it — the memory-discovery rule: the owner's org drive refuses, so not all are readable.
    expect((await memberDrivesReadableByModel(credentialActor(w.owner, null), realtime)).allReadable).toBe(false);
    await setPolicies({ providerAllowlist: ['openai'], modelAllowlist: [realtime.modelId] });
    expect((await memberDrivesReadableByModel(credentialActor(w.owner, null), realtime)).allReadable).toBe(true);
  });

  it('saving: an agent page\'s provider/model write to a model the org does not allow is refused and nothing is written; an allowed one is saved', async () => {
    await expect(saveModel(REFUSED)).rejects.toBeInstanceOf(OrgModelPolicyError);
    await expect(saveModel(REFUSED)).rejects.toMatchObject({ refusal: { status: 403, policy: 'modelAllowlist' } });
    expect(await agentRow()).toEqual({ aiProvider: ALLOWED.provider, aiModel: ALLOWED.model });

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    await saveModel(REFUSED);
    expect(await agentRow()).toEqual({ aiProvider: REFUSED.provider, aiModel: REFUSED.model });
  });

  it('saving: an agent page created in an org drive with a model the org does not allow is refused 403 and not created', async () => {
    const before = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive));
    const result = await pageService.createPage(credentialActor(w.owner, null), { title: 'Analyst', type: 'AI_CHAT', driveId: w.orgDrive, aiProvider: REFUSED.provider, aiModel: REFUSED.model });

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive))).toHaveLength(before.length);
    expect(await pageService.createPage(credentialActor(w.owner, null), { title: 'Analyst', type: 'AI_CHAT', driveId: w.orgDrive, aiProvider: ALLOWED.provider, aiModel: ALLOWED.model })).toMatchObject({ success: true });
  });

  it('saving: copying an agent page into an org drive that does not allow its model is refused 403 and copies nothing; one it allows is copied', async () => {
    const outsideAgent = (await factories.createPage(w.personalDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model })).id;
    const copy = () => bulkCopy(new Request('http://localhost/api/pages/bulk-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageIds: [outsideAgent], targetDriveId: w.orgDrive, targetParentId: null, includeChildren: false }),
    }));
    const orgPages = async () => (await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive))).length;
    const before = await orgPages();

    const refused = await copy();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_policy', policy: 'modelAllowlist' });
    expect(await orgPages()).toBe(before);

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect((await copy()).status).toBe(200);
    expect(await orgPages()).toBe(before + 1);
  });

  it('bringing in: moving an agent page into an org drive that does not allow its model is refused 403 naming the policy, and nothing moves', async () => {
    const outsideAgent = (await factories.createPage(w.personalDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model })).id;
    const move = () => movePagesToDrive({
      pageIds: [outsideAgent],
      targetDriveId: w.orgDrive,
      targetParentId: null,
      userId: w.owner,
      authorize: { isDriveInScope: async () => true, canAdministerDrive: async () => true, canEditPage: async () => true },
    });
    const driveOf = async () => (await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, outsideAgent)))[0]?.driveId;

    expect(await move()).toMatchObject({ success: false, code: 'ORG_POLICY', status: 403, policy: 'modelAllowlist' });
    expect(await driveOf()).toBe(w.personalDrive);

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect(await move()).toMatchObject({ success: true });
    expect(await driveOf()).toBe(w.orgDrive);
  });

  it('bringing in: moving a drive whose agent the org does not allow into the org is refused 403 naming the policy, and the drive stays out', async () => {
    const outsideDrive = (await factories.createDrive(w.owner)).id;
    created.driveIds.push(outsideDrive);
    await factories.createPage(outsideDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model });
    const moveIn = () => moveDriveIn(new Request(`http://localhost/api/drives/${outsideDrive}/org`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: w.orgId }),
    }), { params: Promise.resolve({ driveId: outsideDrive }) });
    const orgOf = async () => (await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, outsideDrive)))[0]?.orgId;

    const refused = await moveIn();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_policy', policy: 'modelAllowlist' });
    expect(await orgOf()).toBeNull();

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect((await moveIn()).status).toBe(200);
    expect(await orgOf()).toBe(w.orgId);
  });

  it('consulting: ask_agent is judged by the TARGET agent\'s org — a global-assistant caller and a caller in another org\'s drive are refused an agent whose model its org does not allow, a null model falling back to the default', async () => {
    // The agent sets no model: it runs DEFAULT_MODEL, which org A does not allow.
    const agentId = (await factories.createPage(w.orgDrive, { type: 'AI_CHAT', aiProvider: null, aiModel: null, title: 'Analyst' })).id;
    await setPolicies({ modelAllowlist: [REFUSED.model] });
    expect(DEFAULT_MODEL).not.toBe(REFUSED.model);
    const otherOrg = createId();
    created.orgIds.push(otherOrg);
    await db.insert(organizations).values({ id: otherOrg, name: 'Contoso', slug: `co-${createId()}`, ownerId: w.owner, policies: {} });
    await db.insert(orgMembers).values({ orgId: otherOrg, userId: w.owner, role: 'OWNER' });
    const otherOrgDrive = (await factories.createDrive(w.owner, { orgId: otherOrg, orgVisibility: 'RESTRICTED' })).id;
    created.driveIds.push(otherOrgDrive);
    const ask = (context: ToolExecutionContext) => executeAskAgent({ agentPath: '/Analyst', agentId, question: 'What changed?' }, { experimental_context: context });

    generateText.mockClear();
    const fromGlobal = await ask({ userId: w.owner, accessActor: credentialActor(w.owner, null) } as ToolExecutionContext);
    const fromOtherOrg = await ask({ userId: w.owner, accessActor: credentialActor(w.owner, null), creditSpend: { spend: driveSpend(otherOrgDrive) } } as ToolExecutionContext);

    for (const result of [fromGlobal, fromOtherOrg]) expect(JSON.stringify(result)).toContain("doesn't allow that AI model");
    expect(generateText).not.toHaveBeenCalled();
  });

  describe('tools reading org content through an agent run: judged by the model the run RESOLVED, never the caller\'s, never skipped', () => {
    // Agent X lives in org A (Northwind, here allowing every model) and sets no model, so it runs DEFAULT_MODEL. X has
    // been added to a drive of org B (a cross-drive agent), which allows only the non-default model (the one the other
    // tests call REFUSED), so not DEFAULT_MODEL.
    const crossDriveAgent = async () => {
      await setPolicies({});
      const orgB = createId();
      created.orgIds.push(orgB);
      await db.insert(organizations).values({ id: orgB, name: 'Contoso', slug: `co-${createId()}`, ownerId: w.owner, policies: { modelAllowlist: [REFUSED.model], crossDriveAgents: true } });
      await db.insert(orgMembers).values({ orgId: orgB, userId: w.owner, role: 'OWNER' });
      const orgBDrive = (await factories.createDrive(w.owner, { orgId: orgB, orgVisibility: 'RESTRICTED' })).id;
      created.driveIds.push(orgBDrive);
      const orgBDoc = (await factories.createPage(orgBDrive, { content: '<p>Contoso merger terms</p>' })).id;
      const agentId = (await factories.createPage(w.orgDrive, { type: 'AI_CHAT', aiProvider: null, aiModel: null, title: 'Analyst', enabledTools: ['read_page'] })).id;
      await db.insert(driveAgentMembers).values({ driveId: orgBDrive, agentPageId: agentId, role: 'MEMBER', addedBy: w.owner });
      expect(REFUSED.model).not.toBe(DEFAULT_MODEL);
      toolRead.pageId = orgBDoc;
      return { agentId, orgBDoc };
    };

    it('ask_agent: the consulted agent\'s tools are judged by ITS resolved model (the default), not the caller\'s — refused org B\'s page', async () => {
      const { agentId } = await crossDriveAgent();
      const ask = (context: ToolExecutionContext) => executeAskAgent({ agentPath: '/Analyst', agentId, question: 'What are the terms?' }, { experimental_context: context });

      // A caller running a model org B allows, and a caller naming no model (the global assistant's shape).
      await ask({ userId: w.owner, accessActor: credentialActor(w.owner, null), aiProvider: REFUSED.provider, aiModel: REFUSED.model } as ToolExecutionContext);
      await ask({ userId: w.owner, accessActor: credentialActor(w.owner, null) } as ToolExecutionContext);

      expect(toolRead.outcomes).toHaveLength(2);
      for (const outcome of toolRead.outcomes) {
        expect(outcome).toMatch(/^refused: .*Insufficient permissions/);
        expect(outcome).not.toContain('Contoso merger terms');
      }
    });

    it('consult route: an agent with no model is judged as the default it runs — refused org B\'s page', async () => {
      const { agentId } = await crossDriveAgent();

      const response = await consult(new Request('http://localhost/api/ai/page-agents/consult', { method: 'POST', body: JSON.stringify({ agentId, question: 'What are the terms?' }) }));

      expect(response.status).toBe(200);
      expect(toolRead.outcomes).toHaveLength(1);
      expect(toolRead.outcomes[0]).toMatch(/^refused: .*Insufficient permissions/);
    });

    it('a context that runs a model but names no resolved model is refused (fail closed); a context that runs none is not judged', async () => {
      const { orgBDoc } = await crossDriveAgent();

      expect(await canActorViewPage({ userId: w.owner, accessActor: credentialActor(w.owner, null), runsModel: true } as ToolExecutionContext, orgBDoc)).toBe(false);
      expect(await canActorViewPage({ userId: w.owner, accessActor: credentialActor(w.owner, null) } as ToolExecutionContext, orgBDoc)).toBe(true);
    });
  });

  it('tools reading org content: a chat\'s tools cannot read a page or drive of an org that does not allow the running model; with an allowed model they can', async () => {
    const as = (pair: { provider: string; model: string }) => ({ userId: w.owner, accessActor: credentialActor(w.owner, null), aiProvider: pair.provider, aiModel: pair.model } as ToolExecutionContext);

    expect(await canActorViewPage(as(REFUSED), w.orgDocPage)).toBe(false);
    expect(await canActorAccessDrive(as(REFUSED), w.orgDrive)).toBe(false);
    expect(await getActorAccessiblePagesInDrive(as(REFUSED), w.orgDrive)).toEqual([]);

    expect(await canActorViewPage(as(ALLOWED), w.orgDocPage)).toBe(true);
    expect(await canActorAccessDrive(as(ALLOWED), w.orgDrive)).toBe(true);
    expect((await getActorAccessiblePagesInDrive(as(ALLOWED), w.orgDrive)).map((p) => p.id)).toContain(w.orgDocPage);

    // A personal drive has no org: the running model never restricts it.
    expect(await canActorAccessDrive(as(REFUSED), w.personalDrive)).toBe(true);
  });

  it('tools reading org content: the global assistant (no drive) reading an org page with read_page under a model the org does not allow is refused; under an allowed model it reads', async () => {
    const readPage = pageReadTools.read_page.execute!;
    const asGlobal = (pair: { provider: string; model: string }) => ({ toolCallId: 't', messages: [], experimental_context: { userId: w.owner, accessActor: credentialActor(w.owner, null), aiProvider: pair.provider, aiModel: pair.model } as ToolExecutionContext });
    await db.update(pages).set({ content: '<p>Q3 revenue plan</p>' }).where(eq(pages.id, w.orgDocPage));

    await expect(readPage({ title: 'Plan', pageId: w.orgDocPage }, asGlobal(REFUSED))).rejects.toThrow(/Insufficient permissions/);

    expect(JSON.stringify(await readPage({ title: 'Plan', pageId: w.orgDocPage }, asGlobal(ALLOWED)))).toContain('Q3 revenue plan');
  });

  describe('commands reading org content: a command page reaches a run\'s model only when its org allows that model', () => {
    // The person's own command, whose entry page (and its one child) live in the org drive, which allows only ALLOWED.
    const orgCommand = async () => {
      await db.update(pages).set({ content: '<p>Q3 release checklist</p>' }).where(eq(pages.id, w.orgDocPage));
      await factories.createPage(w.orgDrive, { parentId: w.orgDocPage, title: 'Rollback runbook' });
      const [command] = await db.insert(commands).values({ userId: w.owner, createdById: w.owner, trigger: 'release-plan', description: 'How we ship', entryPageId: w.orgDocPage }).returning({ id: commands.id });
      return command.id;
    };
    const run = (pair: { provider: string; model: string }) => toolModelContext({ provider: pair.provider, modelName: pair.model });

    it('load_skill: a command whose page\'s org does not allow the run\'s model is not loaded; under an allowed model it is', async () => {
      await orgCommand();
      const loadSkill = skillTools.load_skill.execute!;
      const load = (pair: { provider: string; model: string }) => loadSkill({ name: 'release-plan' }, { toolCallId: 't', messages: [], experimental_context: { userId: w.owner, accessActor: credentialActor(w.owner, null), ...run(pair) } as ToolExecutionContext });

      const refused = String(await load(REFUSED));
      expect(refused).not.toContain('Q3 release checklist');
      expect(refused).not.toContain('Rollback runbook');
      expect(refused).toContain('could not be loaded');

      expect(String(await load(ALLOWED))).toContain('Q3 release checklist');
    });

    it('slash commands: a command chip whose page\'s org does not allow the turn\'s model is skipped, not injected; under an allowed model it is injected', async () => {
      const commandId = await orgCommand();
      const planned = await planCommandExecutions(`/[release-plan](${commandId}:command) ship it`, credentialActor(w.owner, null), { driveId: w.orgDrive });

      const refused = await commandsForModel(planned, run(REFUSED));
      expect(refused.plans).toEqual([expect.objectContaining({ kind: 'skip', reason: 'no_access', commandId })]);
      expect(refused.prompt).not.toContain('Q3 release checklist');
      expect(refused.prompt).not.toContain('Rollback runbook');

      const allowed = await commandsForModel(planned, run(ALLOWED));
      expect(allowed.prompt).toContain('Q3 release checklist');
      expect(allowed.prompt).toContain('Rollback runbook');
    });
  });

  it('generating images: the image model is built through the provider factory and refused in a drive whose org does not allow it', async () => {
    await setPolicies({ modelAllowlist: [ALLOWED.model] });
    expect(await createImageProvider({ model: DEFAULT_IMAGE_MODEL }, { driveId: w.orgDrive })).toMatchObject({ status: 403, code: 'org_policy', policy: 'modelAllowlist' });
    expect(isProviderError(await createImageProvider({ model: DEFAULT_IMAGE_MODEL }, { driveId: w.personalDrive }))).toBe(false);

    await setPolicies({ modelAllowlist: [ALLOWED.model, DEFAULT_IMAGE_MODEL] });
    expect(isProviderError(await createImageProvider({ model: DEFAULT_IMAGE_MODEL }, { driveId: w.orgDrive }))).toBe(false);
  });

  it('offering: the model list an org drive offers is its allowlist; a personal drive offers the whole catalog (null)', async () => {
    await setPolicies({ modelAllowlist: [ALLOWED.model], providerAllowlist: [ALLOWED.provider] });
    expect(await offeredModels(w.orgDrive)).toEqual({ [ALLOWED.provider]: [ALLOWED.model] });
    expect(await offeredModels(w.personalDrive)).toBeNull();
    expect(await offeredModels(null)).toBeNull();
  });

  it('reading: a person\'s background model reads only drives, and pages in drives, whose org allows it', async () => {
    const personalPage = (await factories.createPage(w.personalDrive)).id;
    const scope = { driveIds: [w.orgDrive, w.personalDrive], pageIds: [w.orgDocPage, personalPage] };

    expect(await scopeReadableByModel({ provider: REFUSED.provider, modelId: REFUSED.model }, scope)).toEqual({ driveIds: [w.personalDrive], pageIds: [personalPage] });
    const allowed = await scopeReadableByModel({ provider: ALLOWED.provider, modelId: ALLOWED.model }, scope);
    expect(allowed.driveIds).toEqual([w.orgDrive, w.personalDrive]);
    expect([...allowed.pageIds].sort()).toEqual([w.orgDocPage, personalPage].sort());
  });
});
